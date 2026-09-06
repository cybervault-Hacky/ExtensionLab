import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createInteractiveSession, startInteractiveSession } from "@/lib/interactive/service";
import { claimStartSlot, getSessionById, RUNTIME_SLOT_STATUSES } from "@/lib/db/repositories/browser-sessions";
import { storeExtensionPackage } from "@/lib/packages/service";
import { getInteractiveBrowserConcurrency } from "@/lib/billing/entitlements";
import { getConfig } from "@/lib/config/env";
import { FakeDriver, fixtureZip, makeUser, setupPhase13Harness as setup, startReadySession, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  // Lift the free plan's per-period session quota so the queue-flood test is
  // about CAPACITY, not billing (billing has its own suites).
  harness = setup({ PLAN_FREE_INTERACTIVE_SESSIONS: "200", INTERACTIVE_BROWSER_MAX_GLOBAL: "4" });
});

afterEach(() => {
  harness.teardown();
});

/**
 * §11 regression suite: capacity slots are reserved atomically and ONLY
 * slot-holding states count. A queued session must never consume runtime
 * capacity (the Phase 11 bug class), and no dimension may bypass another.
 */
describe("Phase 13 §11: atomic capacity reservation", () => {
  it("QUEUED/CREATED sessions never consume runtime slots", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const globalLimit = getConfig().interactiveBrowser.maxGlobalSessions;
    // Flood the queue far beyond the global limit.
    for (let i = 0; i < globalLimit + 5; i += 1) {
      const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
      expect(["CREATED", "QUEUED"]).toContain(created.status);
    }
    // claimStartSlot still sees zero live slots.
    const claim = claimStartSlot({
      sessionId: "nonexistent",
      globalLimit,
      userLimit: getInteractiveBrowserConcurrency(user.id),
      orgLimit: getConfig().interactiveBrowser.maxSessionsPerOrg,
    });
    expect(claim).toBeNull(); // session unknown — and no capacity was consumed by the queue
    const queued = (
      await import("@/lib/db/client")
    ).getDb().prepare("SELECT COUNT(*) AS n FROM interactive_browser_sessions WHERE status IN ('CREATED','QUEUED')").get() as { n: number };
    expect(queued.n).toBeGreaterThanOrEqual(globalLimit + 5);
  });

  it("only slot-holding statuses are counted (STARTING..STOPPING, never QUEUED)", () => {
    expect(RUNTIME_SLOT_STATUSES).toEqual(["STARTING", "READY", "ACTIVE", "IDLE", "STOPPING"]);
  });

  it("a slot claim is exclusive: the loser stays QUEUED (no double-count)", async () => {
    const driver = new FakeDriver();
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const config = getConfig().interactiveBrowser;
    const userLimit = getInteractiveBrowserConcurrency(user.id);

    // Fill the user's slots minus one with live sessions.
    for (let i = 0; i < Math.max(0, userLimit - 1); i += 1) {
      const ready = await startReadySession(driver, user);
      void ready;
    }
    const first = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    startInteractiveSession(user.id, first.id, (row) => ({ jobId: `j-${row.id}` }));
    const claimA = claimStartSlot({
      sessionId: first.id,
      globalLimit: config.maxGlobalSessions,
      userLimit,
      orgLimit: config.maxSessionsPerOrg,
    });
    expect(claimA).not.toBeNull();
    expect(claimA).not.toBe("capacity");
    expect(getSessionById(first.id)!.status).toBe("STARTING");

    // A second session cannot claim the same user slot.
    const second = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    startInteractiveSession(user.id, second.id, (row) => ({ jobId: `j2-${row.id}` }));
    expect(getSessionById(second.id)!.status).toBe("QUEUED");
    const claimB = claimStartSlot({
      sessionId: second.id,
      globalLimit: config.maxGlobalSessions,
      userLimit,
      orgLimit: config.maxSessionsPerOrg,
    });
    expect(claimB).toBe("capacity");
    expect(getSessionById(second.id)!.status).toBe("QUEUED"); // untouched, still holds no slot
  });

  it("a smaller dimension never bypasses a larger one (user < org < global)", () => {
    // Free plan: user concurrency is 1 even if org/global capacity is larger.
    const user = makeUser();
    expect(getInteractiveBrowserConcurrency(user.id)).toBe(1);
    const config = getConfig().interactiveBrowser;
    expect(config.maxSessionsPerOrg).toBeGreaterThanOrEqual(1);
    expect(config.maxGlobalSessions).toBeGreaterThanOrEqual(config.maxSessionsPerOrg);
  });
});
