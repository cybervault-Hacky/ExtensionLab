import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNextJob, completeJob, failJob, requeueFailedJob } from "@/lib/db/repositories/jobs";
import { RUNTIME_SLOT_STATUSES, getSessionById, listAdmittedSessions } from "@/lib/db/repositories/browser-sessions";
import { createInteractiveBrowserStartHandler } from "@/lib/jobs/handlers/interactive-browser";
import { createInteractiveSession, startInteractiveSession, stopInteractiveSession } from "@/lib/interactive/service";
import { storeExtensionPackage } from "@/lib/packages/service";
import { countUsageThisMonth } from "@/lib/db/repositories/usage";
import { FakeDriver, enqueueStart, fakeContext, fixtureZip, makeUser, setupHarness, type Harness } from "./helpers";
import type { JobRow } from "@/lib/db/schema/types";

/**
 * Deterministic interactive-session load test: a fixed workload of session
 * starts is drained by simulated workers against the REAL start handler and
 * the fake runtime. Capacity is deliberately oversubscribed so the queue must
 * apply backpressure (retryable BROWSER_SESSION_LIMIT) and forward progress
 * only happens as sessions are stopped. Invariants are checked after every
 * step and must hold on every run: global and per-user caps are never
 * exceeded, every session eventually starts exactly once, exactly one usage
 * unit is recorded per started session, and no container survives.
 */

let harness: Harness;

beforeEach(() => {
  harness = setupHarness({ INTERACTIVE_BROWSER_MAX_GLOBAL: "6" });
});
afterEach(() => harness.teardown());

describe("deterministic interactive session load", () => {
  it("drains an oversubscribed workload with backpressure and no cap violations", async () => {
    const driver = new FakeDriver();
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });

    const USERS = 8;
    const SESSIONS_PER_USER = 2;
    const GLOBAL_CAP = 6; // matches INTERACTIVE_BROWSER_MAX_GLOBAL
    const WORKERS = 4;

    const users = Array.from({ length: USERS }, () => makeUser());
    const sessionIds: string[] = [];
    for (const user of users) {
      const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
      for (let n = 0; n < SESSIONS_PER_USER; n += 1) {
        const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
        startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
        sessionIds.push(created.id);
      }
    }
    expect(sessionIds).toHaveLength(USERS * SESSIONS_PER_USER); // 16 starts for 6 slots

    // Capacity invariants count only sessions that hold a runtime slot
    // (QUEUED sessions wait for capacity; they are not load themselves).
    const admittedRows = () =>
      listAdmittedSessions().filter((row) => sessionIds.includes(row.id) && RUNTIME_SLOT_STATUSES.includes(row.status as never));
    const admittedCount = () => admittedRows().length;
    const admittedForUser = (userId: string) => admittedRows().filter((row) => row.user_id === userId).length;

    let peakAdmitted = 0;
    const checkInvariants = () => {
      const admitted = admittedCount();
      peakAdmitted = Math.max(peakAdmitted, admitted);
      expect(admitted).toBeLessThanOrEqual(GLOBAL_CAP);
      for (const user of users) expect(admittedForUser(user.id)).toBeLessThanOrEqual(1); // free concurrency
    };

    // One worker tick: claim → run → complete (or retry on capacity).
    const tick = async (workerId: string): Promise<"completed" | "capacity" | "idle"> => {
      const claimed = claimNextJob({ workerId, types: ["INTERACTIVE_BROWSER_START"], leaseMs: 60_000, scanLimit: 50 });
      if (!claimed) return "idle";
      const job = claimed as JobRow;
      try {
        const payload = JSON.parse(job.payload_json) as { sessionId: string };
        await handler.handle(fakeContext<"INTERACTIVE_BROWSER_START">(job, payload));
        completeJob(job.id, { drained: true });
        checkInvariants();
        return "completed";
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "BROWSER_SESSION_LIMIT") {
          // Retryable: the real queue backs off; simulate by failing + requeue.
          failJob(job.id, code, "capacity");
          requeueFailedJob(job.id);
          return "capacity";
        }
        throw error;
      }
    };

    const drainRound = async (): Promise<{ completed: number; capacity: number }> => {
      let completed = 0;
      let capacity = 0;
      for (let w = 0; w < WORKERS; w += 1) {
        // Each worker keeps claiming until the queue view is exhausted once.
        for (;;) {
          const outcome = await tick(`w${w}`);
          if (outcome === "completed") completed += 1;
          else {
            // "capacity" requeues the job — claiming again immediately would
            // spin on the same job, so move on; "idle" means no claim at all.
            if (outcome === "capacity") capacity += 1;
            break;
          }
        }
      }
      return { completed, capacity };
    };

    // Phase 1: drain until only capacity-blocked starts remain.
    let started = 0;
    for (let guard = 0; guard < sessionIds.length * 4; guard += 1) {
      const round = await drainRound();
      started += round.completed;
      checkInvariants();
      if (round.capacity === 0) break;
      // Free exactly one slot, then continue — deterministic forward progress.
      const admitted = getSessionById(
        sessionIds.find((id) => getSessionById(id)?.status === "READY") ?? "",
      );
      expect(admitted).toBeDefined();
      await stopInteractiveSession(admitted!.user_id, admitted!.id, driver);
    }
    expect(started).toBe(sessionIds.length); // every session started exactly once
    expect(peakAdmitted).toBe(GLOBAL_CAP); // the queue really saturated the cap
    expect(driver.runners).toHaveLength(sessionIds.length); // one real container per session

    // Phase 2: stop everything that is still admitted.
    const stillAdmitted = admittedRows();
    for (const row of stillAdmitted) {
      await stopInteractiveSession(row.user_id, row.id, driver);
      checkInvariants();
    }

    for (const id of sessionIds) {
      const row = getSessionById(id)!;
      expect(row.status).toBe("STOPPED");
      expect(row.stop_reason).toBe("stopped_by_user");
    }
    expect(driver.removedContainers).toHaveLength(sessionIds.length); // no container survives
    for (const user of users) {
      expect(countUsageThisMonth(user.id, "interactive_browser")).toBe(SESSIONS_PER_USER); // exactly one unit each
    }
  }, 120_000);
});
