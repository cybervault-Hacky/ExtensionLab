import "server-only";
import { rm } from "node:fs/promises";
import { generateEventId } from "./ids";
import { sanitizeError } from "./security";
import { SandboxRuntimeError } from "./errors";
import { getSandboxConfig, type SandboxConfig } from "./config";
import type {
  CreateSandboxResponse,
  ExtensionRuntimeStatus,
  NetworkEntry,
  RuntimeEvent,
  RuntimeEventLevel,
  RuntimeEventType,
  SandboxAction,
  SandboxInfo,
  SandboxSnapshot,
  SandboxStatus,
} from "@/types/runtime";
import type { TestAction } from "@/lib/testing/types";
import type { BrowserId } from "@/lib/browsers/types";
import type { ContainerHandle, SandboxDriver } from "./driver";
import { generateReferenceId, generateSandboxId, generateSessionToken } from "./ids";

interface CreateSandboxInput {
  sourcePath: string;
  testUrl?: string;
  clientIp: string;
  /** Phase 9: browser runtime for this sandbox (defaults to Chromium). */
  browserId?: BrowserId;
}

type EventListener = (event: RuntimeEvent) => void;

const ACTIVE_STATUSES: SandboxStatus[] = [
  "preparing",
  "creating",
  "starting",
  "loading_extension",
  "ready",
  "running",
  "stopping",
  "completed",
  "failed",
  "timeout",
];

const RUNNING_STATUSES: SandboxStatus[] = ["starting", "loading_extension", "ready", "running"];

export class SandboxManager {
  private readonly sandboxes = new Map<string, SandboxSnapshot>();
  private readonly handles = new Map<string, ContainerHandle>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ipWindowCounts = new Map<string, { count: number; resetAt: number }>();
  private orphanTimer: NodeJS.Timeout | null = null;
  private readonly driver: SandboxDriver;
  private readonly config: SandboxConfig;

  constructor(driver: SandboxDriver, config: SandboxConfig = getSandboxConfig()) {
    this.driver = driver;
    this.config = config;
    this.orphanTimer = setInterval(() => {
      void this.cleanupOrphans();
    }, config.orphanCheckIntervalMs);
    this.orphanTimer.unref?.();
  }

  dispose(): void {
    if (this.orphanTimer) clearInterval(this.orphanTimer);
  }

  async create(input: CreateSandboxInput): Promise<CreateSandboxResponse> {
    if (await this.isDriverAvailable()) {
      // available
    } else {
      throw new SandboxRuntimeError(
        "environment_unavailable",
        "The isolated sandbox environment is not available.",
        generateReferenceId(),
      );
    }

    if (this.activeCount() >= this.config.maxConcurrentSandboxes) {
      throw new SandboxRuntimeError(
        "capacity_reached",
        "Sandbox capacity reached. Your test will start when a slot becomes available.",
        generateReferenceId(),
      );
    }

    if (this.isRateLimited(input.clientIp)) {
      throw new SandboxRuntimeError(
        "rate_limited",
        "Too many sandboxes were created recently. Please wait and try again.",
        generateReferenceId(),
      );
    }

    const sandboxId = generateSandboxId();
    const token = generateSessionToken();
    const referenceId = generateReferenceId();
    const snapshot: SandboxSnapshot = {
      sandboxId,
      token,
      referenceId,
      status: "preparing",
      testUrl: input.testUrl,
      sourcePath: input.sourcePath,
      browserId: input.browserId ?? "chromium",
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.sandboxTtlMs,
      events: [],
      network: [],
      suppressedEvents: 0,
    };
    this.sandboxes.set(sandboxId, snapshot);

    this.recordSandboxCreation(input.clientIp);
    this.emit(snapshot, {
      id: generateEventId(),
      timestamp: Date.now(),
      type: "sandbox",
      level: "info",
      source: "sandbox-manager",
      message: "Sandbox session created.",
    });

    return { sandboxId, sessionToken: token, referenceId, status: snapshot.status };
  }

  async start(sandboxId: string, token: string): Promise<SandboxInfo> {
    const snapshot = this.requireSnapshot(sandboxId, token);
    if (this.statusIsRunning(snapshot.status)) return this.toPublicInfo(snapshot);

    this.setStatus(snapshot, "creating", "Creating isolated environment");
    let handle: ContainerHandle;
    try {
      handle = await this.driver.create(snapshot.sandboxId, snapshot.sourcePath, snapshot.token, {
        browserId: snapshot.browserId,
      });
    } catch (error) {
      const clean = sanitizeError(error instanceof Error ? error.message : "Docker driver failed.");
      this.setStatus(snapshot, "failed", clean.message);
      throw new SandboxRuntimeError(
        "runner_unavailable",
        clean.message,
        snapshot.referenceId,
      );
    }
    this.handles.set(sandboxId, handle);

    this.setStatus(snapshot, "loading_extension", "Loading extension in isolated browser");
    const response = await handle.controlClient.command(
      "start",
      handle.runnerToken,
      { testUrl: snapshot.testUrl },
      12000,
    );
    if (!response.ok) {
      this.setStatus(snapshot, "failed", response.message ?? "Extension failed to load.");
      throw new SandboxRuntimeError(
        "extension_load_failed",
        response.message ?? "Extension failed to load.",
        snapshot.referenceId,
      );
    }

    await this.attachStream(snapshot, handle);
    this.setStatus(snapshot, "running", "Sandbox ready.");
    snapshot.startedAt = Date.now();
    this.scheduleTimeout(snapshot);
    return this.toPublicInfo(snapshot);
  }

  async stop(sandboxId: string, token: string): Promise<SandboxInfo> {
    const snapshot = this.requireSnapshot(sandboxId, token);
    if (snapshot.status === "destroyed") return this.toPublicInfo(snapshot);

    this.setStatus(snapshot, "stopping", "Stopping sandbox");
    const handle = this.handles.get(sandboxId);
    if (handle) {
      await handle.controlClient.command("stop", handle.runnerToken, {}, 5000).catch(() => undefined);
    }

    await this.destroy(snapshot, "destroyed", "Sandbox destroyed.");
    return this.toPublicInfo(snapshot);
  }

  async reload(sandboxId: string, token: string): Promise<SandboxInfo> {
    const snapshot = this.requireSnapshot(sandboxId, token, true);
    const handle = this.requireHandle(sandboxId);
    await handle.controlClient.command("reload", handle.runnerToken, {}, 5000);
    this.emitSandboxEvent(snapshot, "info", "Page reload requested.");
    return this.toPublicInfo(snapshot);
  }

  async openUrl(sandboxId: string, token: string, url: string): Promise<SandboxInfo> {
    const snapshot = this.requireSnapshot(sandboxId, token, true);
    const handle = this.requireHandle(sandboxId);
    await handle.controlClient.command("open-url", handle.runnerToken, { url }, 6000);
    snapshot.testUrl = url;
    this.emitSandboxEvent(snapshot, "info", `Opened ${url}`);
    return this.toPublicInfo(snapshot);
  }

  async restartExtension(sandboxId: string, token: string): Promise<SandboxInfo> {
    const snapshot = this.requireSnapshot(sandboxId, token, true);
    const handle = this.requireHandle(sandboxId);
    await handle.controlClient.command("restart-extension", handle.runnerToken, {}, 6000);
    this.emitSandboxEvent(snapshot, "info", "Extension restart requested.");
    return this.toPublicInfo(snapshot);
  }

  async clearConsole(sandboxId: string, token: string): Promise<SandboxInfo> {
    const snapshot = this.requireSnapshot(sandboxId, token, true);
    snapshot.events = snapshot.events.filter((event) => event.type !== "console" && event.type !== "error");
    snapshot.network = [];
    snapshot.suppressedEvents = 0;
    this.emitSandboxEvent(snapshot, "info", "Console cleared.");
    return this.toPublicInfo(snapshot);
  }

  async screenshot(sandboxId: string, token: string): Promise<Uint8Array | null> {
    const snapshot = this.requireSnapshot(sandboxId, token, true);
    const handle = this.requireHandle(sandboxId);
    return handle.controlClient.screenshot(handle.runnerToken);
  }

  getEvents(sandboxId: string, token: string): RuntimeEvent[] {
    const snapshot = this.requireSnapshot(sandboxId, token);
    return snapshot.events;
  }

  getNetwork(sandboxId: string, token: string): NetworkEntry[] {
    const snapshot = this.requireSnapshot(sandboxId, token);
    return snapshot.network;
  }

  getInfo(sandboxId: string, token: string): SandboxInfo {
    const snapshot = this.requireSnapshot(sandboxId, token);
    return this.toPublicInfo(snapshot);
  }

  async executeTestAction(
    sandboxId: string,
    token: string,
    action: TestAction,
  ): Promise<{ ok: boolean; data?: Record<string, unknown>; message?: string }> {
    const snapshot = this.requireSnapshot(sandboxId, token, true);
    const handle = this.requireHandle(sandboxId);
    return handle.controlClient.testAction(handle.runnerToken, action);
  }

  subscribe(sandboxId: string, listener: EventListener): () => void {
    const set = this.listeners.get(sandboxId) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(sandboxId, set);
    return () => set.delete(listener);
  }

  async cleanupOrphans(): Promise<void> {
    for (const snapshot of this.sandboxes.values()) {
      if (statusShouldBeExpired(snapshot)) {
        await this.destroy(snapshot, "timeout", "Sandbox timed out. The environment was automatically destroyed.");
      }
    }
  }

  private requireSnapshot(
    sandboxId: string,
    token: string,
    mustBeRunning = false,
  ): SandboxSnapshot {
    const snapshot = this.sandboxes.get(sandboxId);
    if (!snapshot) {
      throw new SandboxRuntimeError("not_found", "Sandbox was not found.", generateReferenceId());
    }
    if (snapshot.token !== token) {
      throw new SandboxRuntimeError("unauthorized", "Unauthorized sandbox access.", generateReferenceId());
    }
    if (mustBeRunning && !RUNNING_STATUSES.includes(snapshot.status)) {
      throw new SandboxRuntimeError("invalid_action", "The sandbox is not running.", snapshot.referenceId);
    }
    return snapshot;
  }

  private requireHandle(sandboxId: string): ContainerHandle {
    const handle = this.handles.get(sandboxId);
    if (!handle) {
      throw new SandboxRuntimeError("runner_unavailable", "The sandbox runner is unavailable.", generateReferenceId());
    }
    return handle;
  }

  private async attachStream(
    snapshot: SandboxSnapshot,
    handle: ContainerHandle,
  ): Promise<void> {
    await handle.controlClient.streamEvents(
      handle.runnerToken,
      (event) => this.onRuntimeEvent(snapshot, event),
      () => this.emitSandboxEvent(snapshot, "warning", "Sandbox event stream closed."),
    );
  }

  private onRuntimeEvent(snapshot: SandboxSnapshot, incoming: RuntimeEvent): void {
    const copy: RuntimeEvent = { ...incoming };
    if (
      copy.type === "browser" &&
      copy.metadata &&
      typeof copy.metadata.product === "string" &&
      typeof copy.metadata.version === "string" &&
      copy.metadata.version.length > 0
    ) {
      // Phase 9: record the exact browser version the runner detected.
      snapshot.browserInfo = {
        product: String(copy.metadata.product).slice(0, 64),
        version: String(copy.metadata.version).slice(0, 32),
      };
      snapshot.browserVersion = snapshot.browserInfo.version;
    }
    if (copy.type === "network") {
      const entry: NetworkEntry = {
        id: copy.id,
        timestamp: copy.timestamp,
        method: String(copy.metadata?.method ?? "GET"),
        url: String(copy.metadata?.url ?? ""),
        status: typeof copy.metadata?.status === "number" ? copy.metadata.status : null,
        resourceType: String(copy.metadata?.resourceType ?? "network"),
        duration: typeof copy.metadata?.duration === "number" ? copy.metadata.duration : 0,
      };
      snapshot.network.push(entry);
    }

    if (snapshot.events.length >= this.config.maxEvents) {
      snapshot.suppressedEvents += 1;
      return;
    }
    snapshot.events.push(copy);
    this.emit(snapshot, copy);
  }

  private scheduleTimeout(snapshot: SandboxSnapshot): void {
    const existing = this.timers.get(snapshot.sandboxId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.destroy(snapshot, "timeout", "Sandbox timed out. The environment was automatically destroyed.");
    }, this.config.maxRuntimeMs);
    timer.unref?.();
    this.timers.set(snapshot.sandboxId, timer);
  }

  private async destroy(
    snapshot: SandboxSnapshot,
    status: SandboxStatus,
    message: string,
  ): Promise<void> {
    const timer = this.timers.get(snapshot.sandboxId);
    if (timer) clearTimeout(timer);
    this.timers.delete(snapshot.sandboxId);

    const handle = this.handles.get(snapshot.sandboxId);
    if (handle) {
      await this.driver.remove(handle).catch(() => undefined);
      this.handles.delete(snapshot.sandboxId);
    }

    snapshot.status = status;
    snapshot.completedAt = Date.now();
    snapshot.stateReason = message;
    snapshot.events.push({
      id: generateEventId(),
      timestamp: Date.now(),
      type: "sandbox",
      level: status === "timeout" ? "warning" : "info",
      source: "sandbox-manager",
      message,
    });
    await rm(snapshot.sourcePath, { recursive: true, force: true }).catch(() => undefined);
    snapshot.sourcePath = "";
    this.emitSandboxEvent(snapshot, status === "timeout" ? "warning" : "info", message);
    setTimeout(() => {
      this.sandboxes.delete(snapshot.sandboxId);
      this.listeners.delete(snapshot.sandboxId);
    }, this.config.cleanupGraceMs).unref?.();
  }

  private setStatus(snapshot: SandboxSnapshot, status: SandboxStatus, message: string): void {
    if (snapshot.status === "destroyed") return;
    snapshot.status = status;
    snapshot.stateReason = message;
    this.emitSandboxEvent(snapshot, "info", message);
  }

  private emitSandboxEvent(
    snapshot: SandboxSnapshot,
    level: RuntimeEventLevel,
    message: string,
  ): void {
    const event: RuntimeEvent = {
      id: generateEventId(),
      timestamp: Date.now(),
      type: "sandbox",
      level,
      source: "sandbox-manager",
      message,
      metadata: { status: snapshot.status },
    };
    snapshot.events.push(event);
    this.emit(snapshot, event);
  }

  private emit(snapshot: SandboxSnapshot, event: RuntimeEvent): void {
    const listeners = this.listeners.get(snapshot.sandboxId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not affect sandbox operation.
      }
    }
  }

  private toPublicInfo(snapshot: SandboxSnapshot): SandboxInfo {
    const extension = snapshot.extension;
    const browserProduct = snapshot.browserInfo?.product
      ?? (snapshot.browserId === "firefox"
        ? "Firefox"
        : snapshot.browserId === "edge"
          ? "Microsoft Edge"
          : "Chromium");
    const info: SandboxInfo = {
      sandboxId: snapshot.sandboxId,
      status: snapshot.status,
      browser: {
        product: browserProduct,
        version: snapshot.browserInfo?.version ?? "isolated-container",
        state: RUNNING_STATUSES.includes(snapshot.status) ? "running" : "stopped",
      },
      testUrl: snapshot.testUrl,
      createdAt: snapshot.createdAt,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
      reason: snapshot.stateReason,
      referenceId: snapshot.referenceId,
      extension: extension ?? { manifestVersionLabel: "", extensionState: "detected", serviceWorkerState: "detected", contentScriptsState: "detected", popupState: "detected" },
    };
    return info;
  }

  private activeCount(): number {
    let count = 0;
    for (const snapshot of this.sandboxes.values()) {
      if (ACTIVE_STATUSES.includes(snapshot.status)) count += 1;
    }
    return Math.min(count, this.config.maxConcurrentSandboxes);
  }

  private statusIsRunning(status: SandboxStatus): boolean {
    return RUNNING_STATUSES.includes(status);
  }

  private isRateLimited(ip: string): boolean {
    const window = this.ipWindowCounts.get(ip);
    if (!window || window.resetAt < Date.now()) return false;
    return window.count >= this.config.maxSandboxesPerWindow;
  }

  private recordSandboxCreation(ip: string): void {
    const existing = this.ipWindowCounts.get(ip);
    const now = Date.now();
    if (!existing || existing.resetAt < now) {
      this.ipWindowCounts.set(ip, { count: 1, resetAt: now + this.config.rateLimitWindowMs });
      return;
    }
    existing.count += 1;
  }

  private async isDriverAvailable(): Promise<boolean> {
    try {
      return await this.driver.available();
    } catch {
      return false;
    }
  }
}

function statusShouldBeExpired(snapshot: SandboxSnapshot): boolean {
  return snapshot.status !== "destroyed" && snapshot.expiresAt < Date.now();
}
