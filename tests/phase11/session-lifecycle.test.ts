import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createInteractiveBrowserStartHandler, createInteractiveBrowserStopHandler } from "@/lib/jobs/handlers/interactive-browser";
import type { JobHandler } from "@/lib/jobs/types";
import { parseRuntimeInfo, createInteractiveSession, sendInput, startInteractiveSession, stopInteractiveSession } from "@/lib/interactive/service";
import { runInteractiveSweep } from "@/lib/interactive/sweep";
import {
  getSessionById,
  listSessionEvents,
} from "@/lib/db/repositories/browser-sessions";
import { getJobById } from "@/lib/db/repositories/jobs";
import { storeExtensionPackage } from "@/lib/packages/service";
import { FakeDriver, makeUser, setupHarness, waitFor, enqueueStart, fakeContext, fixtureZip, startReadySession, type Harness } from "./helpers";
import type { JobRow } from "@/lib/db/schema/types";

/**
 * Session lifecycle: CREATED → QUEUED → STARTING → READY → ACTIVE → terminal,
 * with the real job handler against the deterministic fake runtime.
 */

let harness: Harness;
let driver: FakeDriver;

beforeEach(() => {
  harness = setupHarness();
  driver = new FakeDriver();
});

afterEach(() => {
  harness.teardown();
});

describe("interactive browser session lifecycle", () => {
  it("creates a session bound to the exact package version and SHA-256", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const row = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    expect(row.status).toBe("CREATED");
    expect(row.package_sha256).toBe(stored.package.sha256);
    expect(row.package_version).toBe("1.2.0");
    expect(row.browser).toBe("chromium");
    expect(row.runtime_json).toBe("{}");
    const events = listSessionEvents(row.id);
    expect(events.map((event) => event.type)).toContain("session_created");
  });

  it("moves CREATED → QUEUED → READY with real extension-load evidence", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    expect(queued.status).toBe("QUEUED");

    const handler = createInteractiveBrowserStartHandler({
      driver,
      sandboxProbe: async () => ({ available: true }),
    }) as JobHandler<"INTERACTIVE_BROWSER_START">;
    const job = getJobById(queued.job_id!)!;
    await handler.handle(fakeContext(job, { sessionId: queued.id }));

    const ready = getSessionById(queued.id)!;
    expect(ready.status).toBe("READY");
    expect(ready.browser_version).toBe("140.0.0.0");
    expect(ready.ready_at).not.toBeNull();

    const types = listSessionEvents(queued.id).map((event) => event.type);
    expect(types).toContain("browser_starting");
    expect(types).toContain("browser_ready");
    expect(types).toContain("extension_loaded");
    expect(types).toContain("extension_loading");

    // The extension metadata panel captured the popup and manifest facts.
    const info = JSON.parse(ready.extension_info_json) as { popupPath: string; hasServiceWorker: boolean; permissions: string[] };
    expect(info.popupPath).toBe("popup.html");
    expect(info.hasServiceWorker).toBe(true);
    expect(info.permissions).toContain("storage");
  });

  it("extracts the package into an isolated temp directory and removes it on stop", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    await handler.handle(fakeContext(getJobById(queued.job_id!)!, { sessionId: queued.id }));

    const ready = getSessionById(queued.id)!;
    const runtime = parseRuntimeInfo(ready)!;
    expect(runtime.tempDir).toContain("ibrowser_");
    expect(existsSync(runtime.tempDir)).toBe(true);
    expect(runtime.containerId).not.toBe("");

    const stopped = await stopInteractiveSession(user.id, queued.id, driver);
    expect(stopped.status).toBe("STOPPED");
    expect(stopped.stop_reason).toBe("stopped_by_user");
    expect(existsSync(runtime.tempDir)).toBe(false);
    expect(driver.removedContainers).toContain(runtime.containerId);
    const types = listSessionEvents(queued.id).map((event) => event.type);
    expect(types).toContain("session_stopping");
    expect(types).toContain("session_stopped");
  });

  it("marks the session ACTIVE after input", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    await handler.handle(fakeContext(getJobById(queued.job_id!)!, { sessionId: queued.id }));

    await sendInput(user.id, queued.id, { type: "click", x: 100, y: 100 });
    const active = getSessionById(queued.id)!;
    expect(active.status).toBe("ACTIVE");
    expect(active.last_activity_at).not.toBeNull();
    expect(driver.latestRunner().inputs).toHaveLength(1);
  });

  it("expires sessions at the maximum lifetime through the sweep", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    await handler.handle(fakeContext(getJobById(queued.job_id!)!, { sessionId: queued.id }));
    const runtime = parseRuntimeInfo(getSessionById(queued.id)!)!;

    // Travel past the deadline by rewinding the row's clock.
    const db = (await import("@/lib/db/client")).getDb();
    db.prepare("UPDATE interactive_browser_sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, queued.id);

    const report = await runInteractiveSweep(driver);
    expect(report.expiredSessions).toBe(1);
    const expired = getSessionById(queued.id)!;
    expect(expired.status).toBe("EXPIRED");
    expect(expired.stop_reason).toBe("max_lifetime");
    expect(driver.removedContainers).toContain(runtime.containerId);
    expect(existsSync(runtime.tempDir)).toBe(false);
    expect(listSessionEvents(queued.id).map((event) => event.type)).toContain("session_expired");
  });

  it("transitions ACTIVE → IDLE → EXPIRED through the idle timeout", async () => {
    harness.teardown();
    harness = setupHarness({
      INTERACTIVE_BROWSER_IDLE_TIMEOUT_MS: String(30_000),
      INTERACTIVE_BROWSER_IDLE_GRACE_MS: String(30_000),
    });
    driver = new FakeDriver();
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    await handler.handle(fakeContext(getJobById(queued.job_id!)!, { sessionId: queued.id }));
    const runtime = parseRuntimeInfo(getSessionById(queued.id)!)!;

    // Simulate inactivity older than the idle timeout.
    const db = (await import("@/lib/db/client")).getDb();
    db.prepare("UPDATE interactive_browser_sessions SET last_activity_at = ? WHERE id = ?").run(Date.now() - 60_000, queued.id);

    let report = await runInteractiveSweep(driver);
    expect(report.idleSessions).toBe(1);
    expect(getSessionById(queued.id)!.status).toBe("IDLE");
    expect(listSessionEvents(queued.id).map((event) => event.type)).toContain("session_idle");

    // Still IDLE (inside grace) — container alive.
    expect(driver.removedContainers).not.toContain(runtime.containerId);

    // Past the grace window (measured from the IDLE transition, i.e. updated_at).
    db.prepare("UPDATE interactive_browser_sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(
      Date.now() - 120_000,
      Date.now() - 60_000,
      queued.id,
    );
    report = await runInteractiveSweep(driver);
    expect(report.idleExpiredSessions).toBe(1);
    const expired = getSessionById(queued.id)!;
    expect(expired.status).toBe("EXPIRED");
    expect(expired.stop_reason).toBe("idle_timeout");
    expect(driver.removedContainers).toContain(runtime.containerId);
  });

  it("fails the session when the browser or extension fails to start", async () => {
    const failingDriver = new FakeDriver();
    const originalCreate = failingDriver.create.bind(failingDriver);
    failingDriver.create = async (
      sandboxId: string,
      sourcePath: string,
      runnerToken: string,
      options?: { browserId?: string },
    ) => {
      const handle = await originalCreate(sandboxId, sourcePath, runnerToken, options);
      // Runner refuses to start: simulate failed browser start.
      (
        failingDriver.latestRunner() as unknown as {
          options: { startResult: { ok: boolean; message?: string } };
        }
      ).options = {
        startResult: { ok: false, message: "The extension did not load in the isolated browser." },
      };
      return handle;
    };
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver: failingDriver, sandboxProbe: async () => ({ available: true }) });
    await expect(
      handler.handle(fakeContext(getJobById(queued.job_id!)!, { sessionId: queued.id })),
    ).rejects.toThrow();

    const failed = getSessionById(queued.id)!;
    expect(failed.status).toBe("FAILED");
    expect(failed.stop_reason).toBe("browser_start_failed");
    const events = listSessionEvents(queued.id).map((event) => event.type);
    expect(events).toContain("runtime_error");
    expect(events).toContain("session_stopped");
  });

  it("treats a repeated start job as a no-op once READY (idempotency)", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    const job = getJobById(queued.job_id!)!;
    await handler.handle(fakeContext(job, { sessionId: queued.id }));
    const containersAfterFirst = driver.runners.length;
    const result = await handler.handle(fakeContext(job, { sessionId: queued.id }));
    expect((result as { skipped?: boolean }).skipped).toBe(true);
    expect(driver.runners.length).toBe(containersAfterFirst);
    expect(getSessionById(queued.id)!.status).toBe("READY");
  });

  it("stop job is idempotent and releases a not-yet-consumed reservation", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    // Stop before start: reservation must be released.
    const stopHandler = createInteractiveBrowserStopHandler({ driver });
    await stopHandler.handle(fakeContext({ id: "job_stop" } as JobRow, { sessionId: created.id, reason: "stopped_by_user", to: "STOPPED" }));
    const stopped = getSessionById(created.id)!;
    expect(stopped.status).toBe("STOPPED");
    await stopHandler.handle(fakeContext({ id: "job_stop" } as JobRow, { sessionId: created.id, reason: "stopped_by_user", to: "STOPPED" }));
    expect(getSessionById(created.id)!.status).toBe("STOPPED");
  });

  it("consumes exactly one interactive_browser usage unit when READY", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    await handler.handle(fakeContext(getJobById(queued.job_id!)!, { sessionId: queued.id }));
    const { countUsageThisMonth } = await import("@/lib/db/repositories/usage");
    expect(countUsageThisMonth(user.id, "interactive_browser")).toBe(1);
  });

  it("recovers a stale STARTING session on retry (worker crash mid-start)", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const db = (await import("@/lib/db/client")).getDb();
    db.prepare("UPDATE interactive_browser_sessions SET status = 'STARTING' WHERE id = ?").run(queued.id);

    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    await handler.handle(fakeContext(getJobById(queued.job_id!)!, { sessionId: queued.id }));
    await waitFor(() => (getSessionById(queued.id)!.status === "READY" ? getSessionById(queued.id) : null));
    expect(getSessionById(queued.id)!.status).toBe("READY");
  });
});
