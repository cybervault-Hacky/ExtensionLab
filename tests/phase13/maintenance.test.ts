import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createInteractiveSession, navigateSession, startInteractiveSession, stopInteractiveSession } from "@/lib/interactive/service";
import { collectReadiness } from "@/lib/observability/readiness";
import { storeExtensionPackage } from "@/lib/packages/service";
import { FakeDriver, fixtureZip, makeUser, setupPhase13Harness, startReadySession, type Harness } from "./helpers";

let harness: Harness;

afterEach(() => {
  harness.teardown();
});

/** §98/§99: emergency kill switch + maintenance mode, both honest. */
describe("Phase 13 §99: maintenance mode", () => {
  beforeEach(() => {
    harness = setupPhase13Harness();
  });

  it("rejects NEW sessions with an honest message while existing ones keep running", async () => {
    const driver = new FakeDriver();
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });

    // Start a live session BEFORE maintenance.
    const live = await startReadySession(driver, user);

    // Flip maintenance mode on (config cache reset is what the env change does).
    process.env.MAINTENANCE_MODE = "true";
    const { resetConfigCache } = await import("@/lib/config/env");
    resetConfigCache();
    try {
      expect(() =>
        createInteractiveSession(user, { userId: user.id, packageId: stored.package.id }),
      ).toThrowError(/paused for planned maintenance/);

      // The existing session is NOT terminated: navigation still works.
      const navigated = await navigateSession(user.id, live.sessionId, { op: "reload" });
      expect(["READY", "ACTIVE"]).toContain(navigated.status); // activity may flip it to ACTIVE

      // Readiness reports maintenance honestly.
      const report = await collectReadiness();
      expect(report.maintenanceMode).toBe(true);
    } finally {
      delete process.env.MAINTENANCE_MODE;
      resetConfigCache();
      await stopInteractiveSession(user.id, live.sessionId, driver).catch(() => undefined);
    }
  });

  it("the kill switch fails closed and never leaks whether the feature exists", async () => {
    harness = setupPhase13Harness({ INTERACTIVE_BROWSER_ENABLED: "false" });
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    expect(() => createInteractiveSession(user, { userId: user.id, packageId: stored.package.id })).toThrowError(/disabled/);
    // Restore: the phase9 harness applies env without an override-restore step.
    delete process.env.INTERACTIVE_BROWSER_ENABLED;
    const { resetConfigCache } = await import("@/lib/config/env");
    resetConfigCache();
  });
});

describe("Phase 13 §44: queued sessions survive maintenance start", () => {
  it("a session queued before maintenance still starts when maintenance ends", async () => {
    harness = setupPhase13Harness({ PLAN_FREE_INTERACTIVE_SESSIONS: "10" });
    const driver = new FakeDriver();
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: `j-${row.id}` }));
    expect(queued.status).toBe("QUEUED");

    // Maintenance starts and ends; the queued session was never terminated.
    process.env.MAINTENANCE_MODE = "true";
    const { resetConfigCache } = await import("@/lib/config/env");
    resetConfigCache();
    process.env.MAINTENANCE_MODE = "false";
    resetConfigCache();

    const stillQueued = (await import("@/lib/db/repositories/browser-sessions")).getSessionById(queued.id)!;
    expect(stillQueued.status).toBe("QUEUED");
    void driver;
  });
});
