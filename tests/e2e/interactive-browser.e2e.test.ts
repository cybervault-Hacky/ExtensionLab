/**
 * Real-Docker end-to-end suite for the interactive extension browser (Phase 11).
 *
 * Exercises the production path with no doubles: stored package → interactive
 * session → INTERACTIVE_BROWSER_START job → real worker → Docker container
 * (pinned sandbox image) → real Chromium with the fixture extension loaded →
 * live frames, console observation, popup rendering inside the container,
 * typed input, screenshot artifact → stop → full cleanup.
 *
 * Requirements: Docker CLI + daemon and the sandbox image
 * (`npm run sandbox:build`). When they are missing the suite skips itself
 * with an explicit reason — unless EXTENSIONLAB_E2E_DOCKER=1 (CI) is set, in
 * which case "unavailable" is a hard failure. Nothing is faked: if the image
 * is absent no session is pretended to exist.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { closeDb } from "@/lib/db/client";
import { resetConfigCache } from "@/lib/config/env";
import { createStorageProvider, setStorageForTests } from "@/lib/storage/storage";
import { setLogLevel } from "@/lib/observability/logger";
import { createUser } from "@/lib/db/repositories/users";
import { storeExtensionPackage } from "@/lib/packages/service";
import { countUsageThisMonth } from "@/lib/db/repositories/usage";
import { getJobById } from "@/lib/db/repositories/jobs";
import { JobWorker } from "@/lib/jobs/worker";
import { createInteractiveBrowserStartHandler, createInteractiveBrowserStopHandler } from "@/lib/jobs/handlers/interactive-browser";
import { createDockerDriver } from "@/lib/runtime/docker-driver";
import { probeSandboxEnvironment, resetSandboxProbeCache } from "@/lib/runtime/availability";
import {
  captureFrame,
  captureScreenshotArtifact,
  createInteractiveSession,
  getConsoleEntries,
  listSessionArtifactViews,
  openPopup,
  parseRuntimeInfo,
  sendInput,
  startInteractiveSession,
  stopInteractiveSession,
  setInteractiveDriverForTests,
  toSessionView,
} from "@/lib/interactive/service";
import { getSessionById, listSessionEvents } from "@/lib/db/repositories/browser-sessions";
import type { UserRecord } from "@/lib/db/repositories/users";

const execFileAsync = promisify(execFile);
const dockerBin = process.env.DOCKER_BIN || "docker";
const image = process.env.SANDBOX_IMAGE || "extensionlab-sandbox:local";
const mustRun = process.env.EXTENSIONLAB_E2E_DOCKER === "1";
const fixtures = join(process.cwd(), "tests", "e2e", "fixtures");

async function listSandboxContainers(): Promise<string[]> {
  const { stdout } = await execFileAsync(dockerBin, ["ps", "-a", "--filter", "label=extensionlab.sandbox=1", "--format", "{{.ID}}"], { timeout: 15_000 });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function zipDirectory(dir: string): Promise<Uint8Array> {
  const zip = new JSZip();
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else zip.file(`${prefix}${entry}`, readFileSync(full));
    }
  };
  walk(dir, "");
  return zip.generateAsync({ type: "uint8array" });
}

async function detectDocker(): Promise<{ available: boolean; reason: string }> {
  resetSandboxProbeCache();
  const probe = await probeSandboxEnvironment(true);
  if (probe.available) return { available: true, reason: "" };
  const reasons: Record<string, string> = {
    disabled: "SANDBOX_DISABLED=true in this environment",
    docker_missing: "Docker CLI is not installed",
    docker_unreachable: "Docker daemon is not reachable",
    image_missing: `sandbox image "${image}" is not built (run: npm run sandbox:build)`,
  };
  return { available: false, reason: reasons[probe.reason ?? ""] ?? "unknown" };
}

const docker = await detectDocker();
if (mustRun && !docker.available) {
  throw new Error(`Interactive browser Docker E2E required (EXTENSIONLAB_E2E_DOCKER=1) but unavailable: ${docker.reason}`);
}
const suite = docker.available ? describe : describe.skip;
if (!docker.available) {
  // eslint-disable-next-line no-console
  console.warn(`[e2e] skipping interactive browser Docker suite: ${docker.reason}`);
}

suite("real interactive browser Docker end-to-end (Phase 11)", () => {
  let dir: string;
  let user: UserRecord;
  let containersBefore: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "el-p11-e2e-"));
    closeDb();
    resetConfigCache();
    process.env.APP_ENV = "test";
    process.env.EXTENSIONLAB_DB_PATH = join(dir, "db.sqlite");
    delete process.env.DATABASE_URL;
    process.env.STORAGE_PATH = join(dir, "storage");
    process.env.SANDBOX_TEMP_ROOT = join(dir, "runtime");
    process.env.WORKER_MODE = "disabled";
    process.env.EMAIL_PROVIDER = "noop";
    process.env.PLAN_FREE_INTERACTIVE_SESSIONS = "5";
    process.env.INTERACTIVE_BROWSER_FRAME_INTERVAL_MS = "300";
    process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? "warn";
    setLogLevel((process.env.E2E_LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "warn");
    resetConfigCache();
    setStorageForTests(createStorageProvider("local", join(dir, "storage")));
    user = createUser({ email: "e2e-interactive@example.com", passwordHash: "x".repeat(60), name: "E2E" });
  });

  afterAll(async () => {
    closeDb();
    setStorageForTests(null);
    setInteractiveDriverForTests(null);
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    containersBefore = await listSandboxContainers();
  });

  afterEach(async () => {
    // Real cleanup verification: no sandbox container may survive a test.
    const after = await listSandboxContainers();
    const leaked = after.filter((id) => !containersBefore.includes(id));
    for (const id of leaked) await execFileAsync(dockerBin, ["rm", "-f", id]).catch(() => undefined);
    expect(leaked, "sandbox containers leaked").toEqual([]);
  });

  async function startSession(): Promise<string> {
    const driver = createDockerDriver(image);
    setInteractiveDriverForTests(driver);
    const bytes = await zipDirectory(join(fixtures, "interactive-extension"));
    const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "interactive-extension.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const worker = new JobWorker({ workerId: `e2e-ibrowser-${process.pid}`, concurrency: 1, pollIntervalMs: 50, leaseMs: 60_000, jobTimeoutMs: 4 * 60_000, shutdownGraceMs: 30_000 });
    worker.register(createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) }));
    try {
      const queued = startInteractiveSession(user.id, created.id, (row) => {
        const { enqueueJob } = require("@/lib/jobs/queue") as typeof import("@/lib/jobs/queue");
        const { job } = enqueueJob({
          type: "INTERACTIVE_BROWSER_START",
          userId: row.user_id,
          priorityClass: "interactive",
          payload: { sessionId: row.id },
          idempotencyKey: `ibrowser-start:${row.id}`,
        });
        return { jobId: job.id };
      });
      expect(await worker.tick()).toBe(true);
      const row = getSessionById(queued.id)!;
      expect(row.status).toBe("READY");
      return queued.id;
    } finally {
      await worker.stop();
    }
  }

  it("loads the exact uploaded package into a disposable Chromium and streams real evidence", async () => {
    const sessionId = await startSession();
    const row = getSessionById(sessionId)!;
    const runtime = parseRuntimeInfo(row)!;
    expect(row.browser).toBe("chromium");
    expect(row.browser_version).toMatch(/\d+/);
    expect(row.package_sha256).toHaveLength(64);
    expect(runtime.containerId).not.toBe("");
    expect(runtime.tempDir).toContain("ibrowser_");
    expect(existsSync(runtime.tempDir)).toBe(true);
    // Extension metadata came from the fixture manifest.
    const view = toSessionView(row);
    expect(view.extension.popupPath).toBe("popup.html");
    expect(view.extension.hasServiceWorker).toBe(true);
    expect(view.extension.hasContentScripts).toBe(true);

    // The service worker really ran: its console line flows through the hub.
    const deadline = Date.now() + 30_000;
    let sawWorkerLog = false;
    while (Date.now() < deadline && !sawWorkerLog) {
      const entries = getConsoleEntries(user.id, sessionId).entries;
      sawWorkerLog = entries.some((entry) => entry.message.includes("[interactive-fixture] service worker started"));
      if (!sawWorkerLog) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(sawWorkerLog).toBe(true);

    // Real PNG frames for the page target.
    const frame = await captureFrame(user.id, sessionId, "page");
    expect(frame).not.toBeNull();
    expect(frame!.bytes[0]).toBe(0x89);
    expect(Buffer.from(frame!.bytes.subarray(1, 4)).toString("ascii")).toBe("PNG");

    // Typed input reaches the real browser (click at viewport centre).
    await expect(sendInput(user.id, sessionId, { type: "click", x: Math.floor(view.viewport.width / 2), y: Math.floor(view.viewport.height / 2) })).resolves.toEqual({ ok: true });
    expect(getSessionById(sessionId)!.status).toBe("ACTIVE");

    // The popup renders INSIDE the container and its frame is a PNG too.
    const opened = await openPopup(user.id, sessionId);
    expect(opened.popup_open).toBe(1);
    const popupFrame = await captureFrame(user.id, sessionId, "popup");
    expect(popupFrame).not.toBeNull();
    expect(popupFrame!.bytes[0]).toBe(0x89);

    // Screenshot artifact is retained and integrity-checked.
    const artifact = await captureScreenshotArtifact(user.id, sessionId, "e2e evidence");
    expect(artifact.url).toContain(sessionId);
    expect(listSessionArtifactViews(user.id, sessionId).map((item) => item.id)).toContain(artifact.id);
    expect(countUsageThisMonth(user.id, "interactive_browser")).toBe(1);

    // Stop: container and extracted package directory are removed.
    await stopInteractiveSession(user.id, sessionId, createDockerDriver(image));
    const stopped = getSessionById(sessionId)!;
    expect(stopped.status).toBe("STOPPED");
    expect(stopped.stop_reason).toBe("stopped_by_user");
    expect(existsSync(runtime.tempDir)).toBe(false);
    expect(listSessionEvents(sessionId).map((event) => event.type)).toContain("session_stopped");
  }, 240_000);

  it("fails closed when the bound package disappears before start", async () => {
    const driver = createDockerDriver(image);
    setInteractiveDriverForTests(driver);
    const bytes = await zipDirectory(join(fixtures, "interactive-extension"));
    const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "interactive-extension-2.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => {
      const { enqueueJob } = require("@/lib/jobs/queue") as typeof import("@/lib/jobs/queue");
      const { job } = enqueueJob({
        type: "INTERACTIVE_BROWSER_START",
        userId: row.user_id,
        priorityClass: "interactive",
        payload: { sessionId: row.id },
        idempotencyKey: `ibrowser-start:${row.id}`,
      });
      return { jobId: job.id };
    });

    // Delete the package between queueing and starting: no substitution.
    const { deleteOwnedPackage } = await import("@/lib/packages/service");
    await deleteOwnedPackage(user.id, stored.package.id);

    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    const job = getJobById(queued.job_id!)!;
    await expect(
      handler.handle({
        job,
        payload: { sessionId: queued.id } as never,
        isCancelled: () => false,
        heartbeat: () => undefined,
        emit: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const failed = getSessionById(queued.id)!;
    expect(failed.status).toBe("FAILED");
    expect(["package_unavailable", "package_hash_mismatch"]).toContain(failed.stop_reason);
    expect(await listSandboxContainers()).toEqual([]); // no container was ever created for this session
  }, 120_000);
});
