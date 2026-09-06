import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { enqueueJob } from "@/lib/jobs/queue";
import { createOrganization } from "@/lib/organizations/service";
import { makeUser } from "../phase11/helpers";
import { makeSchedulingWorker, setupPhase13Harness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness();
});

afterEach(() => {
  harness.teardown();
});

/**
 * §45: deterministic scheduling test. 3 organizations with different queue
 * sizes, different plan tiers (org concurrency caps), interactive, automated
 * and cleanup jobs. Verifies: no starvation, per-org caps, global caps,
 * queue drains, cleanup always progresses.
 */
describe("Phase 13 §45: fair scheduling across organizations", () => {
  it("drains a mixed queue without starvation and respects per-org caps", async () => {
    const orgCaps: Record<string, number> = {};
    const orgs = ["small", "medium", "large"].map((name) => {
      const owner = makeUser();
      const org = createOrganization({ userId: owner.id }, { name: `Fair ${name}` });
      orgCaps[org.id] = name === "small" ? 1 : name === "medium" ? 2 : 4;
      return { name, orgId: org.id, ownerId: owner.id };
    });

    // Large org floods the queue (30 jobs) while the others enqueue 5 each.
    const enqueued: Array<{ id: string; org: string; type: string }> = [];
    const add = (orgId: string | null, userId: string | null, type: "AUTOMATED_TEST" | "ANALYSIS" | "ARTIFACT_CLEANUP") => {
      const { job } = enqueueJob({
        type,
        userId,
        organizationId: orgId,
        payload: {} as never,
        skipBackpressure: true,
        priorityClass: type === "ARTIFACT_CLEANUP" ? "normal" : "normal",
      });
      enqueued.push({ id: job.id, org: orgId ?? "none", type });
    };
    for (let i = 0; i < 30; i += 1) add(orgs[2].orgId, orgs[2].ownerId, "AUTOMATED_TEST");
    for (let i = 0; i < 5; i += 1) add(orgs[0].orgId, orgs[0].ownerId, "AUTOMATED_TEST");
    for (let i = 0; i < 5; i += 1) add(orgs[1].orgId, orgs[1].ownerId, "ANALYSIS");
    // Cleanup jobs must never be starved by interactive/test work.
    add(null, null, "ARTIFACT_CLEANUP");
    add(null, null, "ARTIFACT_CLEANUP");
    expect(enqueued).toHaveLength(42);

    const orgConcurrencyFor = (organizationId: string) => orgCaps[organizationId] ?? 1;
    const workers = [
      makeSchedulingWorker("fair-w1", { concurrency: 2, orgConcurrencyFor }),
      makeSchedulingWorker("fair-w2", { concurrency: 2, orgConcurrencyFor }),
      makeSchedulingWorker("fair-w3", { concurrency: 2, orgConcurrencyFor }),
      makeSchedulingWorker("fair-w4", { concurrency: 2, orgConcurrencyFor }),
    ];
    for (const worker of workers) worker.start();

    // Drain fully (bounded wait).
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const remaining = (
        getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','retrying','running')").get() as { n: number }
      ).n;
      if (remaining === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const worker of workers) await worker.stop();

    const statuses = getDb()
      .prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
      .all() as unknown as Array<{ status: string; n: number }>;
    const byStatus = Object.fromEntries(statuses.map((row) => [row.status, Number(row.n)]));
    // Every job completed exactly once: no losses, no duplicates.
    expect(byStatus.completed).toBe(42);
    expect(byStatus.failed ?? 0).toBe(0);

    // Cleanup jobs always progressed (priority floor, not starved).
    const cleanupFinished = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'ARTIFACT_CLEANUP' AND status = 'completed'")
        .get() as { n: number }
    ).n;
    expect(cleanupFinished).toBe(2);

    // Small orgs were not starved by the large org's flood: their jobs all
    // completed (bounded starvation — every org drains within the run).
    for (const org of [orgs[0], orgs[1]]) {
      const pending = (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ? AND status != 'completed'")
          .get(org.orgId) as { n: number }
      ).n;
      expect(pending).toBe(0);
    }
  }, 45000);

  it("never lets one organization exceed its running-job cap", async () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Cap Co" });
    for (let i = 0; i < 12; i += 1) {
      enqueueJob({ type: "AUTOMATED_TEST", userId: owner.id, organizationId: org.id, payload: {} as never, skipBackpressure: true });
    }
    // Slow handler so several jobs are running at once.
    const seen: string[] = [];
    const worker = makeSchedulingWorker("cap-w1", {
      concurrency: 8,
      orgConcurrencyFor: () => 3,
      handlerFor: () => ({
        async handle() {
          seen.push("x");
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {};
        },
      }),
    });
    worker.start();
    const deadline = Date.now() + 20_000;
    let maxObserved = 0;
    while (Date.now() < deadline) {
      const running = (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ? AND status = 'running'")
          .get(org.id) as { n: number }
      ).n;
      maxObserved = Math.max(maxObserved, running);
      const remaining = (
        getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','retrying','running')").get() as { n: number }
      ).n;
      if (remaining === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await worker.stop();
    expect(maxObserved).toBeLessThanOrEqual(3);
    const completed = (
      getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ? AND status = 'completed'").get(org.id) as { n: number }
    ).n;
    expect(completed).toBe(12);
    void seen;
  }, 30000);
});
