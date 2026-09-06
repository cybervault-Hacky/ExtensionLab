import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { closeDb } from "@/lib/db/client";
import { resetConfigCache } from "@/lib/config/env";
import { setStorageForTests, createStorageProvider } from "@/lib/storage/storage";
import { setEmailProviderForTests } from "@/lib/email/email-service";
import { createUser } from "@/lib/db/repositories/users";
import { setLogLevel } from "@/lib/observability/logger";
import { setInteractiveHubForTests, InteractiveSessionHub } from "@/lib/interactive/runtime";
import JSZip from "jszip";
import { enqueueJob } from "@/lib/jobs/queue";
import { createInteractiveBrowserStartHandler } from "@/lib/jobs/handlers/interactive-browser";
import {
  createInteractiveSession,
  setInteractiveDriverForTests,
  startInteractiveSession,
} from "@/lib/interactive/service";
import { storeExtensionPackage } from "@/lib/packages/service";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { getJobById } from "@/lib/db/repositories/jobs";
import type { JobContext, JobType } from "@/lib/jobs/types";
import type { JobRow } from "@/lib/db/schema/types";
import type { ContainerHandle, CreateSandboxOptions, SandboxDriver } from "@/lib/runtime/driver";
import type { UserRecord } from "@/lib/db/repositories/users";

/**
 * Shared Phase 11 test harness: isolated SQLite database + throw-away storage
 * + a deterministic fake sandbox driver whose "containers" are real in-process
 * HTTP control servers speaking the runner protocol. No Docker required; the
 * same protocol is exercised end-to-end by tests/e2e with real Docker.
 */

export interface Harness {
  dir: string;
  teardown(): void;
}

// Env overrides applied by the last setupHarness call; restored on teardown
// so per-test overrides never leak into later tests in the same file.
let overrides: Array<{ key: string; value: string | undefined }> = [];

export function setupHarness(env: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "el-p11-"));
  for (const { key, value } of overrides) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  overrides = Object.entries(env).map(([key, value]) => ({ key, value: process.env[key] }));
  closeDb();
  resetConfigCache();
  process.env.APP_ENV = "test";
  process.env.EXTENSIONLAB_DB_PATH = join(dir, "db.sqlite");
  delete process.env.DATABASE_URL;
  process.env.STORAGE_PATH = join(dir, "storage");
  process.env.SANDBOX_TEMP_ROOT = join(dir, "runtime");
  process.env.WORKER_MODE = "disabled";
  process.env.EMAIL_PROVIDER = "noop";
  process.env.LOG_LEVEL = "error";
  process.env.INTERACTIVE_BROWSER_MAX_GLOBAL = "4";
  process.env.INTERACTIVE_BROWSER_MAX_PER_ORG = "4";
  process.env.INTERACTIVE_BROWSER_FRAME_INTERVAL_MS = "200";
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  setLogLevel("error");
  resetConfigCache();
  setStorageForTests(createStorageProvider("local", join(dir, "storage")));
  setEmailProviderForTests(null);
  setInteractiveHubForTests(new InteractiveSessionHub());
  return {
    dir,
    teardown() {
      closeDb();
      setStorageForTests(null);
      setEmailProviderForTests(null);
      setInteractiveDriverForTests(null);
      setInteractiveHubForTests(null);
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeUser(email = `user-${Math.random().toString(16).slice(2)}@example.com`): UserRecord {
  return createUser({ email, passwordHash: "x".repeat(60), name: "Test" });
}

// ---------------------------------------------------------------------------
// Deterministic fake runner: real HTTP server speaking the control protocol
// ---------------------------------------------------------------------------

export interface FakeRunnerOptions {
  /** Simulated start outcome. */
  startResult?: { ok: boolean; message?: string; evidence?: string };
  /** Fail after N ms of life (browser crash). */
  crashAfterMs?: number;
  /** Popup behaviour: whether the popup page loads. */
  popupSupported?: boolean;
  /** Simulates a server-side redirect: open-url lands on this URL instead. */
  redirectTo?: string;
  /**
   * Phase 12: queue of inspect-at element payloads (FIFO). An entry of null
   * means "no element at that point". When empty a deterministic button is
   * returned.
   */
  inspectResults?: Array<Record<string, unknown> | null>;
  /** Phase 12: simulated restart-browser outcome. */
  restartResult?: { ok: boolean; message?: string };
  /** Phase 12: simulated clear-state outcome. */
  clearStateResult?: { ok: boolean; message?: string };
}

export interface RunnerCall {
  command: string;
  payload: Record<string, unknown>;
  at: number;
}

export class FakeRunner {
  readonly server: Server;
  port = 0;
  readonly token: string;
  readonly calls: RunnerCall[] = [];
  inputs: Array<Record<string, unknown>> = [];
  url = "about:blank";
  viewport = { width: 1280, height: 800 };
  started = false;
  stopped = false;
  popupOpen = false;
  eventListeners: Set<(event: unknown) => void> = new Set();
  private closeTimer: NodeJS.Timeout | null = null;
  private readonly options: FakeRunnerOptions;
  readonly ready: Promise<void>;

  constructor(token: string, options: FakeRunnerOptions = {}) {
    this.token = token;
    this.options = options;
    this.server = createServer((request, response) => void this.handle(request, response));
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: this.started ? "running" : "idle" }));
      return;
    }
    // The control client sends the runner token via header (commands,
    // screenshots) or query param (event stream) — accept both.
    const tokenOk =
      request.headers["x-sandbox-token"] === this.token ||
      url.searchParams.get("token") === this.token;
    if (!tokenOk) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized." }));
      return;
    }
    if (request.method === "POST" && (url.pathname === "/command" || url.pathname === "/action")) {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      let parsed: { command?: string; action?: Record<string, unknown>; payload?: Record<string, unknown> } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, status: "failed", message: "Invalid body." }));
        return;
      }
      const actionType = parsed.action?.type;
      const command =
        typeof parsed.command === "string" ? parsed.command : typeof actionType === "string" ? actionType : "";
      this.calls.push({ command, payload: (parsed.payload ?? parsed.action ?? {}) as Record<string, unknown>, at: Date.now() });
      const result = this.execute(command, (parsed.payload ?? parsed.action ?? {}) as Record<string, unknown>);
      response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // Node buffers headers until the first write; flush them so SSE clients
      // (fetch/EventSource) see the response immediately, like the real runner.
      response.flushHeaders();
      response.write(": connected\n\n");
      const listener = (event: unknown) => {
        try {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Listener failures must not break the runner.
        }
      };
      this.eventListeners.add(listener);
      request.on("close", () => this.eventListeners.delete(listener));
      return;
    }
    if (request.method === "GET" && url.pathname === "/screenshot") {
      const target = url.searchParams.get("target") === "popup" ? "popup" : "page";
      if (target === "popup" && !this.popupOpen) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Popup screenshot not available." }));
        return;
      }
      // 1x1 transparent PNG — deterministic and tiny.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      response.end(png);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  }

  private execute(command: string, payload: Record<string, unknown>): { ok: boolean; status: string; message?: string; data?: Record<string, unknown> } {
    switch (command) {
      case "start": {
        if (this.options.startResult && !this.options.startResult.ok) {
          return { ok: false, status: "failed", message: this.options.startResult.message ?? "Browser startup failed." };
        }
        this.started = true;
        if (typeof payload.testUrl === "string" && payload.testUrl !== "about:blank") this.url = payload.testUrl;
        if (this.options.crashAfterMs) {
          this.closeTimer = setTimeout(() => {
            this.started = false;
            this.server.close();
          }, this.options.crashAfterMs);
          this.closeTimer.unref?.();
        }
        this.emit({ type: "browser", level: "info", source: "browser", message: "Browser ready: Fake Chromium 140.0.0.0.", metadata: { product: "Chromium", version: "140.0.0.0" } });
        return {
          ok: true,
          status: "running",
          data: { evidence: this.options.startResult?.evidence ?? "background-context", browserVersion: "140.0.0.0" },
        };
      }
      case "open-url":
        this.url = this.options.redirectTo ?? String(payload.url ?? "");
        this.emit({ type: "page", level: "info", source: "page", message: `Opening ${this.url}` });
        return { ok: true, status: this.started ? "running" : "idle", data: { url: this.url } };
      case "reload":
        return { ok: true, status: "running" };
      case "go-back":
      case "go-forward":
        return { ok: true, status: "running" };
      case "get-url":
        return { ok: true, status: "running", data: { url: this.url } };
      case "set-viewport": {
        const width = Number(payload.width);
        const height = Number(payload.height);
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          return { ok: false, status: "running", message: "Viewport dimensions are out of range." };
        }
        this.viewport = { width, height };
        return { ok: true, status: "running", data: { width, height } };
      }
      case "input":
        if (!this.started) return { ok: false, status: "idle", message: "The browser is not running." };
        this.inputs.push(payload.action as Record<string, unknown>);
        return { ok: true, status: "running" };
      case "open-popup": {
        if (this.options.popupSupported === false) {
          return { ok: false, status: "running", message: "The extension popup page did not load." };
        }
        this.popupOpen = true;
        this.emit({ type: "extension", level: "info", source: "extension", message: "Extension popup opened in the isolated browser." });
        return { ok: true, status: "running", data: { width: 380, height: 600 } };
      }
      case "close-popup":
        this.popupOpen = false;
        return { ok: true, status: "running" };
      case "restart-extension":
        this.emit({ type: "extension", level: "info", source: "extension", message: "Extension reloaded." });
        return { ok: true, status: "running" };
      case "inspect-at": {
        const queue = this.options.inspectResults ?? [];
        const element =
          queue.length > 0
            ? (queue.shift() ?? null)
            : {
                exists: true,
                tag: "button",
                id: "login",
                classes: ["btn", "primary"],
                attributes: [
                  { name: "type", value: "submit" },
                  { name: "aria-label", value: "Sign in" },
                ],
                textPreview: "Sign in",
                isPassword: false,
                visible: true,
                rect: { x: 10, y: 10, width: 120, height: 32 },
              };
        return {
          ok: true,
          status: "running",
          data: { element: element ?? { exists: false } },
        };
      }
      case "restart-browser": {
        if (this.options.restartResult && !this.options.restartResult.ok) {
          return { ok: false, status: "failed", message: this.options.restartResult.message ?? "Restart failed." };
        }
        this.popupOpen = false;
        this.started = true;
        this.emit({ type: "browser", level: "info", source: "browser", message: "Browser ready: Fake Chromium 140.0.0.0." });
        return {
          ok: true,
          status: "running",
          data: { evidence: "background-context", browserVersion: "140.0.0.0" },
        };
      }
      case "clear-state": {
        if (this.options.clearStateResult && !this.options.clearStateResult.ok) {
          return { ok: false, status: "running", message: this.options.clearStateResult.message ?? "Clear failed." };
        }
        return { ok: true, status: "running" };
      }
      case "stop":
        this.stopped = true;
        this.started = false;
        return { ok: true, status: "stopped" };
      default:
        return { ok: false, status: "failed", message: "Unsupported command." };
    }
  }

  emit(event: Record<string, unknown>): void {
    for (const listener of this.eventListeners) listener(event);
  }

  emitConsole(message: string, level = "log"): void {
    this.emit({
      id: `fake_${Math.random().toString(16).slice(2)}`,
      timestamp: Date.now(),
      type: "console",
      level,
      source: "page",
      message,
    });
  }

  emitNetwork(url: string, status: number): void {
    this.emit({
      id: `fake_${Math.random().toString(16).slice(2)}`,
      timestamp: Date.now(),
      type: "network",
      level: "info",
      source: "network",
      message: `GET ${url}`,
      metadata: { method: "GET", url, status, resourceType: "document" },
    });
  }

  destroy(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    for (const listener of this.eventListeners) void listener;
    this.eventListeners.clear();
    this.server.close();
  }
}

/**
 * Deterministic sandbox driver: every create() spawns a FakeRunner and copies
 * the package directory reference (no Docker). Records everything the host
 * asked the "docker CLI" to do.
 */
export class FakeDriver implements SandboxDriver {
  readonly name = "fake";
  availableResult = true;
  runners: FakeRunner[] = [];
  removedContainers: string[] = [];
  createdSources: string[] = [];
  runningChecks = new Map<string, boolean>();
  /** Phase 13: label registry for reconciliation tests (containerId -> labels). */
  ownedLabels = new Map<string, { name: string; labels: Record<string, string>; createdAt: number }>();
  /** Phase 13: simulate container-create failures (failure injection). */
  createFailure: { message: string } | null = null;
  private readonly runnerOptions: FakeRunnerOptions;

  /** Every created "container" runner inherits these simulated outcomes. */
  constructor(runnerOptions: FakeRunnerOptions = {}) {
    this.runnerOptions = runnerOptions;
  }

  async available(): Promise<boolean> {
    return this.availableResult;
  }

  async create(sandboxId: string, sourcePath: string, runnerToken: string, options?: CreateSandboxOptions): Promise<ContainerHandle> {
    if (this.createFailure) throw new Error(this.createFailure.message);
    const runner = new FakeRunner(runnerToken, this.runnerOptions);
    await runner.ready;
    this.runners.push(runner);
    this.createdSources.push(sourcePath);
    this.runningChecks.set(sandboxId, true);
    const { ControlClient } = await import("@/lib/runtime/control-client");
    const runnerId = sandboxId;
    // Keep the runner alive until remove(); isRunning consults this map.
    (this as unknown as { runnerIds: Map<string, FakeRunner> }).runnerIds ??= new Map();
    (this as unknown as { runnerIds: Map<string, FakeRunner> }).runnerIds.set(runnerId, runner);
    const containerId = `fakecontainer_${sandboxId}`;
    // Phase 13: mirror the labels the real Docker driver applies.
    this.ownedLabels.set(containerId, {
      name: `extensionlab-${sandboxId}`,
      labels: {
        "extensionlab.environment": process.env.EL_FAKE_DRIVER_ENV ?? "test",
        "extensionlab.session": options?.sessionId ?? sandboxId,
        "extensionlab.browser": "chromium",
        "extensionlab.owner": options?.ownerKind ?? "test",
      },
      createdAt: Date.now(),
    });
    return {
      containerId,
      controlPort: runner.port,
      controlClient: new ControlClient(runner.port),
      runnerToken,
      browserId: "chromium",
    };
  }

  /** Phase 13 §15/§16: label-scoped listing for reconciliation. */
  async listOwnedContainers(): Promise<Array<{ containerId: string; name: string; labels: Record<string, string>; createdAt?: number }>> {
    return [...this.ownedLabels.entries()].map(([containerId, info]) => ({
      containerId,
      name: info.name,
      labels: info.labels,
      createdAt: info.createdAt,
    }));
  }

  /** Test hook: pretend a container belongs to another environment. */
  relabelEnvironment(containerId: string, environment: string): void {
    const info = this.ownedLabels.get(containerId);
    if (info) info.labels["extensionlab.environment"] = environment;
  }

  async remove(handle: ContainerHandle): Promise<void> {
    this.removedContainers.push(handle.containerId);
    this.ownedLabels.delete(handle.containerId);
    const map = (this as unknown as { runnerIds: Map<string, FakeRunner> }).runnerIds;
    for (const [id, runner] of map ?? []) {
      if (`fakecontainer_${id}` === handle.containerId) {
        runner.destroy();
        map.delete(id);
        this.runningChecks.set(id, false);
      }
    }
    for (const runner of this.runners) {
      if (runner.token === handle.runnerToken) runner.destroy();
    }
  }

  async isRunning(handle: ContainerHandle): Promise<boolean> {
    const map = (this as unknown as { runnerIds: Map<string, FakeRunner> }).runnerIds;
    for (const [id] of map ?? []) {
      if (`fakecontainer_${id}` === handle.containerId) return this.runningChecks.get(id) !== false;
    }
    return false;
  }

  /** Simulates a container that vanished (browser crash). */
  markCrashed(containerId: string): void {
    const map = (this as unknown as { runnerIds: Map<string, FakeRunner> }).runnerIds;
    for (const [id, runner] of map ?? []) {
      if (`fakecontainer_${id}` === containerId) {
        runner.destroy();
        this.runningChecks.set(id, false);
      }
    }
  }

  latestRunner(): FakeRunner {
    return this.runners[this.runners.length - 1];
  }
}

export async function waitFor<T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs = 5000,
  label = "condition",
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures: deterministic extension package + job-context helpers
// ---------------------------------------------------------------------------

export const FIXTURE_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "Lifecycle Fixture",
  version: "1.2.0",
  action: { default_popup: "popup.html" },
  background: { service_worker: "background.js" },
  permissions: ["storage"],
  host_permissions: ["https://example.com/*"],
  content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"] }],
});

export async function fixtureZip(manifest: string = FIXTURE_MANIFEST): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", manifest);
  zip.file("background.js", "console.log('background ready');");
  zip.file("popup.html", "<!doctype html><html><body>Popup</body></html>");
  zip.file("content.js", "console.log('content script');");
  return zip.generateAsync({ type: "uint8array" });
}

export function fakeContext<T extends JobType>(job: JobRow, payload: Record<string, unknown>): JobContext<T> {
  return {
    job,
    payload: payload as never,
    isCancelled: () => false,
    heartbeat: () => undefined,
    emit: () => undefined,
    signal: new AbortController().signal,
  } as JobContext<T>;
}

export function enqueueStart(sessionId: string, userId: string): JobRow {
  const { job } = enqueueJob({
    type: "INTERACTIVE_BROWSER_START",
    userId,
    priorityClass: "interactive",
    payload: { sessionId },
    idempotencyKey: `ibrowser-start:${sessionId}`,
    resourceType: "interactive_session",
    resourceId: sessionId,
  });
  return job;
}

/**
 * Full happy-path setup: stores the fixture package, creates + starts the
 * session through the REAL start handler against the fake runtime, and leaves
 * a READY session behind. Also installs the driver for service-level calls
 * (reload/destroy) that resolve the driver themselves.
 */
export async function startReadySession(
  driver: FakeDriver,
  user = makeUser(),
  manifest: string = FIXTURE_MANIFEST,
): Promise<{ user: UserRecord; sessionId: string; runner: FakeRunner }> {
  setInteractiveDriverForTests(driver);
  const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(manifest), fileName: "ext.zip" });
  const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
  const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
  const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
  await handler.handle(fakeContext<"INTERACTIVE_BROWSER_START">(getJobById(queued.job_id!)!, { sessionId: queued.id }));
  const row = getSessionById(queued.id)!;
  if (row.status !== "READY") throw new Error(`startReadySession: expected READY, got ${row.status}`);
  return { user, sessionId: queued.id, runner: driver.latestRunner() };
}
