import "server-only";
import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/config/env";
import { getCoordinationStoreSync } from "@/lib/coordination";
import { ControlClient, isSafeRuntimeEvent, sanitizeRuntimeEvent } from "@/lib/runtime/control-client";
import type { RuntimeEvent } from "@/types/runtime";
import type { ConsoleEntryView, NetworkEntryView } from "@/types/interactive";
import { logger, recordMetric } from "@/lib/observability/logger";

/**
 * Interactive session hub (process-local, Phase 11).
 *
 * Bridges the web tier to the disposable browser containers. The hub
 *  - lazily attaches one SSE connection per live session to the container's
 *    runner (loopback only),
 *  - keeps bounded in-memory rings for the Console/Network/Events panels,
 *  - fans frames out to the workspace SSE subscribers (with per-subscriber
 *    sequence numbers so reconnects replay without gaps),
 *  - rate-limits frames and input per session.
 *
 * Durable session state lives in SQLite; this cache is a projection that any
 * web replica can rebuild by re-attaching. Nothing here is ever exposed raw:
 * events pass through the same sanitizer the Phase 3 control client uses.
 */

export interface HubAttachInfo {
  sessionId: string;
  controlPort: number;
  runnerToken: string;
}

export type HubFrameKind = "console" | "network" | "event" | "state";

export interface HubFrame {
  seq: number;
  kind: HubFrameKind;
  payload: unknown;
}

type Listener = (frame: HubFrame) => void;

interface HubSession {
  info: HubAttachInfo;
  attached: boolean;
  attachGeneration: number;
  console: ConsoleEntryView[];
  network: NetworkEntryView[];
  events: RuntimeEvent[];
  listeners: Set<Listener>;
  seq: number;
  lastFrameFetchAt: { page: number; popup: number };
  frameCache: { page: { bytes: Uint8Array; at: number } | null; popup: { bytes: Uint8Array; at: number } | null };
  inputTimestamps: number[];
}

function frameChannel(sessionId: string): string {
  return `interactive:frames:${sessionId}`;
}

export class InteractiveSessionHub {
  private readonly sessions = new Map<string, HubSession>();
  private readonly detachers = new Map<string, () => void>();
  /** Phase 13 §59: this hub's instance identity (echo suppression). */
  private readonly instanceId = randomUUID();
  /** Cross-instance frame subscriptions, torn down with the session entry. */
  private readonly frameSubs = new Map<string, () => void>();

  private config() {
    return getConfig().interactiveBrowser;
  }

  controlClient(info: HubAttachInfo): ControlClient {
    return new ControlClient(info.controlPort);
  }

  /** Ensures the session has an entry and a live event-stream attachment. */
  ensure(info: HubAttachInfo): HubSession {
    let entry = this.sessions.get(info.sessionId);
    if (!entry) {
      entry = {
        info,
        attached: false,
        attachGeneration: 0,
        console: [],
        network: [],
        events: [],
        listeners: new Set(),
        seq: 0,
        lastFrameFetchAt: { page: 0, popup: 0 },
        frameCache: { page: null, popup: null },
        inputTimestamps: [],
      };
      this.sessions.set(info.sessionId, entry);
      this.subscribeRemote(entry);
    }
    this.attach(entry);
    return entry;
  }

  private attach(entry: HubSession): void {
    if (entry.attached) return;
    entry.attached = true;
    const generation = ++entry.attachGeneration;
    const client = this.controlClient(entry.info);
    void client
      .streamEvents(
        entry.info.runnerToken,
        (event) => this.onRuntimeEvent(entry, event),
        () => {
          // Stream ended: detach; the next consumer triggers a fresh attach.
          if (entry.attachGeneration === generation) {
            entry.attached = false;
            this.emitLocal(entry, "event", {
              id: `hub_${entry.seq}`,
              timestamp: Date.now(),
              type: "sandbox",
              level: "warning",
              source: "session-hub",
              message: "Live event stream disconnected. Reconnecting…",
            });
            if (entry.listeners.size > 0) this.attach(entry);
          }
        },
      )
      .then((detach) => {
        if (entry.attachGeneration !== generation) {
          detach();
          return;
        }
        this.detachers.set(entry.info.sessionId, detach);
      })
      .catch(() => {
        if (entry.attachGeneration === generation) entry.attached = false;
      });
  }

  private onRuntimeEvent(entry: HubSession, raw: RuntimeEvent): void {
    if (!isSafeRuntimeEvent(raw)) return;
    const event = sanitizeRuntimeEvent(raw);
    if (event.type === "console" || event.type === "error") {
      const consoleEntry: ConsoleEntryView = {
        id: event.id,
        timestamp: event.timestamp,
        level: event.level === "warning" || event.level === "error" ? event.level : event.level === "info" ? "info" : "log",
        source: event.source,
        message: event.message,
      };
      entry.console.push(consoleEntry);
      const cap = this.config().consoleRingSize;
      if (entry.console.length > cap) entry.console.splice(0, entry.console.length - cap);
      this.emitLocal(entry, "console", consoleEntry);
      return;
    }

    if (event.type === "network") {
      const url = String(event.metadata?.url ?? "");
      const networkEntry: NetworkEntryView = {
        id: event.id,
        timestamp: event.timestamp,
        method: String(event.metadata?.method ?? "GET"),
        url: url.slice(0, 512),
        status: typeof event.metadata?.status === "number" ? (event.metadata.status as number) : null,
        resourceType: String(event.metadata?.resourceType ?? "network"),
        duration: typeof event.metadata?.duration === "number" ? (event.metadata.duration as number) : 0,
      };
      entry.network.push(networkEntry);
      const cap = this.config().networkRingSize;
      if (entry.network.length > cap) entry.network.splice(0, entry.network.length - cap);
      this.emitLocal(entry, "network", networkEntry);
      return;
    }

    entry.events.push(event);
    const cap = this.config().eventRingSize;
    if (entry.events.length > cap) entry.events.splice(0, entry.events.length - cap);
    this.emitLocal(entry, "event", event);
  }

  /** Broadcasts a session state change to subscribers (no storage). */
  publishState(info: HubAttachInfo, state: unknown): void {
    const entry = this.sessions.get(info.sessionId);
    if (!entry) return;
    this.emitLocal(entry, "state", state);
  }

  private emitLocal(entry: HubSession, kind: HubFrameKind, payload: unknown): void {
    const frame: HubFrame = { seq: ++entry.seq, kind, payload };
    for (const listener of entry.listeners) {
      try {
        listener(frame);
      } catch {
        // Listener failures must never affect the session.
      }
    }
    // Phase 13 §59: fan live frames out to other web instances so SSE works
    // regardless of which instance the client is connected to. Fire-and-forget:
    // cross-instance delivery is best-effort; replay stays DB-based.
    this.publishRemote(entry, frame);
  }

  /** Forwards a frame produced by ANOTHER instance to local listeners only. */
  private emitRemote(entry: HubSession, frame: HubFrame): void {
    for (const listener of entry.listeners) {
      try {
        listener(frame);
      } catch {
        // Listener failures must never affect the session.
      }
    }
  }

  private publishRemote(entry: HubSession, frame: HubFrame): void {
    const store = getCoordinationStoreSync();
    if (!store?.publish) return;
    const envelope = JSON.stringify({
      origin: this.instanceId,
      seq: frame.seq,
      kind: frame.kind,
      payload: frame.payload,
    });
    void store.publish(frameChannel(entry.info.sessionId), envelope).catch(() => undefined);
  }

  /** Subscribes this instance to a session's cross-instance frame channel. */
  private subscribeRemote(entry: HubSession): void {
    if (this.frameSubs.has(entry.info.sessionId)) return;
    const store = getCoordinationStoreSync();
    if (!store?.subscribe) return;
    void store
      .subscribe(frameChannel(entry.info.sessionId), (message) => {
        try {
          const parsed = JSON.parse(message) as { origin?: string; seq?: number; kind?: HubFrameKind; payload?: unknown };
          if (parsed.origin === this.instanceId) return; // own echo
          if (typeof parsed.seq !== "number" || !parsed.kind) return;
          this.emitRemote(entry, { seq: parsed.seq, kind: parsed.kind, payload: parsed.payload });
        } catch {
          // Malformed frames are dropped; replay is DB-based anyway.
        }
      })
      .then((unsubscribe) => {
        // The entry may have been removed while subscribing.
        if (!this.sessions.has(entry.info.sessionId)) unsubscribe();
        else this.frameSubs.set(entry.info.sessionId, unsubscribe);
      })
      .catch(() => undefined);
  }

  /**
   * Subscribes to live frames. Replay on reconnect is snapshot-based: the
   * stream route first sends the current state + rings (sourced from the DB
   * event log and the hub), then live frames — so no Last-Event-ID bookkeeping
   * is needed and reconnects never lose evidence.
   */
  subscribe(info: HubAttachInfo, listener: Listener): () => void {
    const entry = this.ensure(info);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  getConsole(info: HubAttachInfo): ConsoleEntryView[] {
    return [...this.ensure(info).console];
  }

  getNetwork(info: HubAttachInfo): NetworkEntryView[] {
    return [...this.ensure(info).network];
  }

  getRuntimeEvents(info: HubAttachInfo): RuntimeEvent[] {
    return [...this.ensure(info).events];
  }

  clearConsole(info: HubAttachInfo): void {
    const entry = this.ensure(info);
    entry.console = [];
    entry.network = [];
  }

  /**
   * Fetches a frame under the configured maximum frame rate. Requests that
   * arrive early receive the cached frame — the container is never asked to
   * render faster than the deployment allows.
   */
  async captureFrame(info: HubAttachInfo, target: "page" | "popup"): Promise<{ bytes: Uint8Array; cached: boolean } | null> {
    const config = this.config();
    const entry = this.ensure(info);
    const now = Date.now();
    const cache = target === "popup" ? entry.frameCache.popup : entry.frameCache.page;
    if (cache && now - cache.at < config.frameIntervalMs) {
      return { bytes: cache.bytes, cached: true };
    }
    const client = this.controlClient(info);
    const bytes = await client.screenshotForTarget(info.runnerToken, target);
    if (!bytes || bytes.byteLength === 0) return cache ? { bytes: cache.bytes, cached: true } : null;
    if (bytes.byteLength > config.maxFrameBytes) {
      recordMetric("interactive.frame_oversize", 1, { target });
      return cache ? { bytes: cache.bytes, cached: true } : null;
    }
    const fresh = { bytes, at: now };
    if (target === "popup") entry.frameCache.popup = fresh;
    else entry.frameCache.page = fresh;
    return { bytes, cached: false };
  }

  /** Per-session input rate limit (actions per minute). */
  allowInput(info: HubAttachInfo): boolean {
    const limit = this.config().inputActionsPerMinute;
    const entry = this.ensure(info);
    const now = Date.now();
    entry.inputTimestamps = entry.inputTimestamps.filter((at) => now - at < 60_000);
    if (entry.inputTimestamps.length >= limit) return false;
    entry.inputTimestamps.push(now);
    return true;
  }

  /** Drops the session's hub state and detaches the container stream. */
  remove(sessionId: string): void {
    const detach = this.detachers.get(sessionId);
    if (detach) {
      detach();
      this.detachers.delete(sessionId);
    }
    const frameSub = this.frameSubs.get(sessionId);
    if (frameSub) {
      frameSub();
      this.frameSubs.delete(sessionId);
    }
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.attachGeneration++;
      entry.attached = false;
      entry.listeners.clear();
    }
    this.sessions.delete(sessionId);
  }

  activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Detaches every stream (server shutdown). Containers are cleaned by the sweep. */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) {
      this.remove(id);
    }
    logger.info("interactive.hub_disposed", { component: "interactive-hub" });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __extensionlabInteractiveHub: InteractiveSessionHub | undefined;
}

export function getInteractiveHub(): InteractiveSessionHub {
  if (!globalThis.__extensionlabInteractiveHub) {
    globalThis.__extensionlabInteractiveHub = new InteractiveSessionHub();
  }
  return globalThis.__extensionlabInteractiveHub;
}

/** Test hook: replaces the process singleton. */
export function setInteractiveHubForTests(hub: InteractiveSessionHub | null): void {
  globalThis.__extensionlabInteractiveHub = hub ?? undefined;
}
