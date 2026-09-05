import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { enqueueJob } from "@/lib/jobs/queue";
import { claimNextJob, completeJob, countRunningJobsForOrganization, JOB_TYPES } from "@/lib/db/repositories/jobs";
import { createOrganization } from "@/lib/organizations/service";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

/**
 * Deterministic load test: no wall-clock dependence, no randomness in the
 * outcome. A fixed workload across organizations is drained by simulated
 * workers; the invariants (per-org caps never exceeded, full drain, bounded
 * starvation) must hold on every run.
 */

describe("deterministic queue load", () => {
  it("drains a mixed multi-organization workload without cap violations or starvation", () => {
    const owner = makeUser();
    const orgA = createOrganization({ userId: owner.id }, { name: "Load A" });
    const orgB = createOrganization({ userId: owner.id }, { name: "Load B" });
    const orgC = createOrganization({ userId: owner.id }, { name: "Load C" });

    const ORG_CAP = 2;
    const WORKERS = 4;
    const TOTAL = 60;

    // Org A floods; orgs B and C queue a little; some personal jobs mix in.
    const jobs: Array<{ id: string; org: string | null }> = [];
    const users = Array.from({ length: 20 }, () => makeUser());
    let index = 0;
    const push = (org: string | null, key: string) => {
      const job = enqueueJob({
        type: "ANALYSIS",
        userId: users[index % users.length].id,
        organizationId: org,
        idempotencyKey: key,
        payload: { packageId: `pkg_${key}`, extensionId: null },
      }).job;
      jobs.push({ id: job.id, org });
      index += 1;
    };
    for (let n = 0; n < 40; n += 1) push(orgA.id, `a-${n}`);
    for (let n = 0; n < 8; n += 1) push(orgB.id, `b-${n}`);
    for (let n = 0; n < 6; n += 1) push(orgC.id, `c-${n}`);
    for (let n = 0; n < 6; n += 1) push(null, `p-${n}`);
    expect(jobs).toHaveLength(TOTAL);

    // Simulate workers: claim → (virtual execution) → complete, in rounds.
    const running: Array<{ id: string; org: string | null }> = [];
    let completed = 0;
    let firstBClaim: number | null = null;
    let claimRound = 0;
    while (completed < TOTAL && claimRound < TOTAL * 4) {
      claimRound += 1;
      // Fill free slots.
      while (running.length < WORKERS) {
        const claimed = claimNextJob({
          workerId: `w${running.length}`,
          types: JOB_TYPES,
          leaseMs: 60_000,
          orgConcurrency: () => ORG_CAP,
          scanLimit: 50,
        });
        if (!claimed) break;
        running.push({ id: claimed.id, org: claimed.organization_id ?? null });
        if (firstBClaim === null && running[running.length - 1].org === orgB.id) {
          firstBClaim = claimRound;
        }
        // Invariant 1: no organization ever exceeds its concurrency cap.
        for (const org of [orgA.id, orgB.id, orgC.id]) {
          expect(countRunningJobsForOrganization(org)).toBeLessThanOrEqual(ORG_CAP);
        }
      }
      // Complete one in-flight job per tick (deterministic service rate).
      const finished = running.pop();
      if (finished) {
        expect(completeJob(finished.id, { result: "ok" })).toBe(true);
        completed += 1;
      }
    }

    // Invariant 2: the queue fully drains.
    expect(completed).toBe(TOTAL);

    // Invariant 3: bounded starvation — org B's first job is claimed within
    // the first few rounds despite org A's flood.
    expect(firstBClaim).not.toBeNull();
    expect(firstBClaim!).toBeLessThanOrEqual(5);
  });

  it("priority inversion is bounded: an interactive job outranks floods", () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Prio Co" });
    const floodUsers = Array.from({ length: 5 }, () => makeUser());
    for (let n = 0; n < 15; n += 1) {
      enqueueJob({ type: "ANALYSIS", userId: floodUsers[n % 5].id, organizationId: null, idempotencyKey: `flood-${n}`, payload: { packageId: "pkg_f", extensionId: null } });
    }
    const interactive = enqueueJob({
      type: "ANALYSIS",
      userId: owner.id,
      organizationId: org.id,
      priorityClass: "interactive",
      idempotencyKey: "interactive-1",
      payload: { packageId: "pkg_i", extensionId: null },
    }).job;
    const first = claimNextJob({ workerId: "w1", types: JOB_TYPES, leaseMs: 60_000 });
    expect(first?.id).toBe(interactive.id);
    expect(first?.priority).toBeGreaterThan(0);
  });
});
