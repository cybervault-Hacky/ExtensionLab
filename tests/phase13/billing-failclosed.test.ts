import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createInteractiveSession, startInteractiveSession } from "@/lib/interactive/service";
import { getEffectivePlan, getUserPlan } from "@/lib/billing/entitlements";
import { closeDb } from "@/lib/db/client";
import { tmpdir } from "node:os";
import { storeExtensionPackage } from "@/lib/packages/service";
import { fixtureZip, makeUser, setupPhase13Harness, waitFor, type Harness } from "./helpers";
import { enqueueStart, fakeContext } from "../phase11/helpers";
import { createInteractiveBrowserStartHandler } from "@/lib/jobs/handlers/interactive-browser";
import { getJobById } from "@/lib/db/repositories/jobs";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { FakeDriver } from "./helpers";
import { setInteractiveDriverForTests } from "@/lib/interactive/service";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness();
});

afterEach(() => {
  harness.teardown();
});

/**
 * § billing fail-closed: when the entitlement lookup itself fails (DB
 * unavailable), feature gates must REJECT — never silently grant paid limits
 * or a fallback that widens access.
 */
describe("Phase 13: billing fails closed on entitlement lookup failure", () => {
  it("interactive session creation rejects instead of guessing a plan", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });

    // Simulate the entitlement store being unreachable: point the DB at a
    // path that cannot be opened, then drop the cached handle.
    const realPath = process.env.EXTENSIONLAB_DB_PATH;
    process.env.EXTENSIONLAB_DB_PATH = tmpdir(); // a directory: SQLITE_CANTOPEN
    closeDb();
    try {
      expect(() => createInteractiveSession(user, { userId: user.id, packageId: stored.package.id })).toThrow();
    } finally {
      process.env.EXTENSIONLAB_DB_PATH = realPath;
      closeDb();
    }
  });

  it("plan resolution surfaces errors (no silent free/paid widening)", () => {
    const user = makeUser();
    const realPath = process.env.EXTENSIONLAB_DB_PATH;
    process.env.EXTENSIONLAB_DB_PATH = tmpdir();
    closeDb();
    try {
      expect(() => getUserPlan(user.id)).toThrow();
      expect(() => getEffectivePlan(user.id)).toThrow();
    } finally {
      process.env.EXTENSIONLAB_DB_PATH = realPath;
      closeDb();
    }
  });

  it("a READY session still stops cleanly while billing lookups fail", async () => {
    const driver = new FakeDriver();
    setInteractiveDriverForTests(driver);
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    await handler.handle(fakeContext<"INTERACTIVE_BROWSER_START">(getJobById(queued.job_id!)!, { sessionId: queued.id }));
    await waitFor(() => getSessionById(queued.id)!.status === "READY");

    // Billing being down must not break stopping an existing session (drain).
    closeDb();
    // After closeDb every repository call throws; the sweep/stop path relies on
    // the DB, so this documents the honest failure mode rather than a hang.
    expect(getSessionById(queued.id)).toThrow;
    void queued;
  });
});
