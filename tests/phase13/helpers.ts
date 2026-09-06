import { JobWorker } from "@/lib/jobs/worker";
import type { JobHandler, JobType } from "@/lib/jobs/types";
import { setupHarness as setupPhase10Harness } from "../phase10/helpers";
import { FakeDriver, FakeRunner, fixtureZip, makeUser, startReadySession, waitFor } from "../phase11/helpers";

export type { Harness } from "../phase10/helpers";
export { FakeDriver, FakeRunner, fixtureZip, makeUser, startReadySession, waitFor };

/** Phase 13 harness: Phase 10 org/queue isolation unchanged. */
export function setupPhase13Harness(env: Record<string, string> = {}) {
  return setupPhase10Harness(env);
}

const SCHEDULING_TYPES = [
  "AUTOMATED_TEST",
  "ANALYSIS",
  "ARTIFACT_CLEANUP",
  "INTERACTIVE_BROWSER_CLEANUP",
] as JobType[];

/**
 * A scheduling-only worker: the REAL JobWorker claim/lease/fairness machinery
 * with trivially fast handlers (no Docker), for deterministic multi-worker
 * scheduling, fairness and load tests. Handlers can be customized per type.
 */
export function makeSchedulingWorker(
  workerId: string,
  options: {
    concurrency?: number;
    types?: readonly JobType[];
    handlerFor?: (type: JobType) => Partial<JobHandler<never>>;
    orgConcurrencyFor?: (organizationId: string) => number;
  } = {},
): JobWorker {
  const types = options.types ?? SCHEDULING_TYPES;
  const worker = new JobWorker({
    workerId,
    concurrency: options.concurrency ?? 2,
    pollIntervalMs: 5,
    leaseMs: 60_000,
    jobTimeoutMs: 30_000,
    orgConcurrencyFor: options.orgConcurrencyFor,
  });
  for (const type of types) {
    const extra = options.handlerFor?.(type) ?? {};
    worker.register({
      type,
      async handle() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ok: true };
      },
      ...extra,
    } as unknown as JobHandler<never>);
  }
  return worker;
}
