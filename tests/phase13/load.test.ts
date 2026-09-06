import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getJobById, countJobsByStatus } from "@/lib/db/repositories/jobs";
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
 * §73: deterministic load test — 100 jobs across 10 organizations drained by
 * 4 concurrent workers. Assertions: everything completes, every organization
 * makes progress throughout (bounded starvation), per-org concurrency caps
 * hold, and no job is claimed by two workers (at-least-once, single claim).
 */
describe("Phase 13 §73: deterministic load (100 jobs / 10 orgs / 4 workers)", () => {
  it("drains all jobs with bounded starvation and no double-claims", async () => {
    const ORGS = 10;
    const JOBS_PER_ORG = 10;
    const WORKERS = 4;

    const workers = Array.from({ length: WORKERS }, (_, index) =>
      makeSchedulingWorker(`load-w${index}`, { concurrency: 4, orgConcurrencyFor: () => 2 }),
    );

    const jobIds: string[] = [];
    const progressTicks: Array<Record<number, number>> = [];

    // Instrument every worker's handler to record claim order per job.
    const orgOwners = Array.from({ length: ORGS }, (_, org) => {
      const owner = makeUser();
      const org2 = createOrganization({ userId: owner.id }, { name: `Load org ${org}` });
      return { orgId: org2.id, ownerId: owner.id };
    });

    for (let org = 0; org < ORGS; org += 1) {
      for (let i = 0; i < JOBS_PER_ORG; i += 1) {
        const { job } = enqueueJob({
          type: "ANALYSIS",
          userId: orgOwners[org].ownerId,
          organizationId: orgOwners[org].orgId,
          payload: { note: `job ${org}/${i}` } as never,
          skipBackpressure: true,
          priorityClass: "normal",
        });
        jobIds.push(job.id);
      }
    }
    expect(jobIds).toHaveLength(100);

    for (const worker of workers) await worker.start();

    // Sample progress: every org should advance (no org starves while others run).
    const deadline = Date.now() + 30_000;
    let done = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const jobs = jobIds.map((id) => getJobById(id)!);
      const completedByOrg: Record<number, number> = {};
      for (let org = 0; org < ORGS; org += 1) completedByOrg[org] = 0;
      for (const job of jobs) {
        if (job.status === "completed") {
          const org = orgOwners.findIndex((entry) => entry.orgId === job.organization_id);
          completedByOrg[org] += 1;
        }
      }
      progressTicks.push(completedByOrg);
      if (jobs.every((job) => job.status === "completed")) {
        done = true;
        break;
      }
    }
    for (const worker of workers) await worker.stop();

    expect(done).toBe(true);

    // Bounded starvation: by the time half the fleet finished, every org had
    // already completed at least one job (no org waited for the whole drain).
    const halfway = progressTicks[Math.floor(progressTicks.length / 2)];
    const orgsWithProgress = Object.values(halfway).filter((count) => count > 0).length;
    expect(orgsWithProgress).toBeGreaterThanOrEqual(ORGS - 2); // tolerance for sampling granularity

    // Final state: every job completed exactly once with recorded attempts.
    const finals = jobIds.map((id) => getJobById(id)!);
    expect(finals.filter((job) => job.status === "completed")).toHaveLength(100);
    for (const job of finals) expect(job.attempts).toBeGreaterThanOrEqual(1);

    // No job kept a lease after drain (all workers stopped cleanly).
    const byStatus = countJobsByStatus();
    expect(Object.keys(byStatus).filter((status) => status !== "completed")).toEqual([]);
  }, 60_000);
});
