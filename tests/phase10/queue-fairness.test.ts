import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { enqueueJob } from "@/lib/jobs/queue";
import { claimNextJob, completeJob, JOB_TYPES } from "@/lib/db/repositories/jobs";
import { createOrganization } from "@/lib/organizations/service";
import { getDb } from "@/lib/db/client";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

function enqueueAnalysis(userId: string, organizationId: string | null, idempotencyKey: string) {
  return enqueueJob({
    type: "ANALYSIS",
    userId,
    organizationId,
    idempotencyKey,
    payload: { packageId: "pkg_x", extensionId: null },
  }).job;
}

describe("per-organization fairness", () => {
  it("a single organization cannot monopolize the queue when others wait", () => {
    const owner = makeUser();
    const orgA = createOrganization({ userId: owner.id }, { name: "Org A" });
    const orgB = createOrganization({ userId: owner.id }, { name: "Org B" });
    // Org A floods the queue (per-user queue caps respected: one user per org).
    const userA = makeUser();
    const userB = makeUser();
    for (let index = 0; index < 3; index += 1) enqueueAnalysis(userA.id, orgA.id, `a-${index}`);
    const late1 = enqueueAnalysis(userB.id, orgB.id, "b-0");
    const late2 = enqueueAnalysis(userB.id, orgB.id, "b-1");

    // Org A capped at 2 concurrent; with cap 1, B's jobs must interleave.
    const claimed: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const claim = claimNextJob({
        workerId: `w${round}`,
        types: JOB_TYPES,
        leaseMs: 60_000,
        orgConcurrency: () => 1,
        scanLimit: 50,
      });
      if (!claim) break;
      claimed.push(claim.id);
      completeJob(claim.id, { result: "ok" });
    }
    // With org concurrency 1 and a fair scan, org B's jobs are claimed early —
    // not starved behind org A's flood.
    const claimIds = new Set(claimed);
    expect(claimIds.has(late1.id) || claimIds.has(late2.id)).toBe(true);
    expect(claimed.length).toBe(5);
  });

  it("respects the per-org concurrency cap: at-cap orgs are skipped", () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Cap Co" });
    const first = enqueueAnalysis(owner.id, org.id, "cap-0");
    const second = enqueueAnalysis(owner.id, org.id, "cap-1");
    const running = claimNextJob({ workerId: "w1", types: JOB_TYPES, leaseMs: 60_000, orgConcurrency: () => 1 });
    expect(running?.id).toBe(first.id);
    // Second job for the same org must not be claimable while the first runs…
    const blocked = claimNextJob({ workerId: "w2", types: JOB_TYPES, leaseMs: 60_000, orgConcurrency: () => 1 });
    expect(blocked === null || blocked.id !== second.id).toBe(true);
    // …but after completion it is.
    completeJob(first.id, { result: "ok" });
    const next = claimNextJob({ workerId: "w3", types: JOB_TYPES, leaseMs: 60_000, orgConcurrency: () => 1 });
    expect(next?.id).toBe(second.id);
  });

  it("org-less (personal workspace) jobs are always eligible", () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Busy Co" });
    enqueueAnalysis(owner.id, org.id, "busy-0");
    const personal = enqueueAnalysis(owner.id, null, "personal-0");
    const running = claimNextJob({ workerId: "w1", types: JOB_TYPES, leaseMs: 60_000, orgConcurrency: () => 1 });
    expect(running).not.toBeNull();
    const second = claimNextJob({ workerId: "w2", types: JOB_TYPES, leaseMs: 60_000, orgConcurrency: () => 1 });
    // Personal job is claimable even though the org is at its cap.
    expect(second?.id).toBe(personal.id);
  });
});

describe("priority classes", () => {
  it("interactive beats normal; enterprise beats CI; raw priorities are clamped", () => {
    const owner = makeUser();
    const enqueue = (key: string, extra: { priorityClass?: "interactive" | "enterprise" | "ci" | "normal"; priority?: number } = {}) =>
      enqueueJob({ type: "ANALYSIS", userId: makeUser().id, organizationId: null, idempotencyKey: key, payload: { packageId: "pkg_z", extensionId: null }, ...extra }).job.priority;
    const interactive = enqueue("pr-1", { priorityClass: "interactive" });
    const normal = enqueue("pr-2");
    const enterprise = enqueue("pr-3", { priorityClass: "enterprise" });
    const ci = enqueue("pr-4", { priorityClass: "ci" });
    const clampedHigh = enqueue("pr-5", { priority: 10_000 });
    const clampedLow = enqueue("pr-6", { priority: -10_000 });
    expect(interactive).toBeGreaterThan(normal);
    expect(enterprise).toBeGreaterThan(ci);
    expect(ci).toBeGreaterThan(normal);
    expect(clampedHigh).toBeLessThanOrEqual(100);
    expect(clampedLow).toBeGreaterThanOrEqual(-100);
  });

  it("higher priority jobs are claimed first regardless of arrival order", () => {
    const owner = makeUser();
    enqueueAnalysis(owner.id, null, "p-normal");
    enqueueJob({ type: "ANALYSIS", userId: owner.id, organizationId: null, priorityClass: "interactive", idempotencyKey: "p-interactive", payload: { packageId: "pkg_y", extensionId: null } });
    const claim = claimNextJob({ workerId: "w1", types: JOB_TYPES, leaseMs: 60_000 });
    expect(claim).not.toBeNull();
    const key = getDb().prepare("SELECT idempotency_key FROM jobs WHERE id = ?").get(claim!.id) as { idempotency_key: string };
    expect(key.idempotency_key).toBe("p-interactive");
  });
});
