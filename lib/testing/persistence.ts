import "server-only";
import {
  createTestRun,
  getTestRunById,
  requeueTestRunForRetry,
  saveTestRunFinal,
  updateTestRunStage,
  updateTestRunStarted,
  updateTestRunStatus,
  type RunOutcome,
} from "@/lib/db/repositories/test-runs";
import { getOwnedExtension, markExtensionTested } from "@/lib/db/repositories/extensions";
import { countUsageThisMonth, recordUsage } from "@/lib/db/repositories/usage";
import { appendJobEvent } from "@/lib/db/repositories/jobs";
import { consumeReservationForResource, releaseReservationForResource } from "@/lib/db/repositories/quota";
import { getActivePlan } from "@/lib/db/plan";
import { getDb, transaction } from "@/lib/db/client";
import { logger, recordMetric } from "@/lib/observability/logger";
import { exportTestResults } from "./diagnostics";
import type {
  DiagnosticFinding,
  TestResult,
  TestRunInfo,
  TestRunSnapshot,
  TestRunStage,
  TestScore,
} from "./types";
import type { TestRunPersistenceHooks } from "./test-runner";

/**
 * Legacy in-memory reservation used by the Phase 4/5 in-process flow. Phase 6
 * runs reserve quota in the database (see lib/db/repositories/quota.ts); this
 * map only remains for the embedded fallback path and tests.
 */
const pendingByUser = new Map<string, Set<string>>();

export function canCreateTestRun(userId: string): boolean {
  const plan = getActivePlan();
  const used = countUsageThisMonth(userId, "test_run");
  const pending = pendingByUser.get(userId)?.size ?? 0;
  return used + pending < plan.testRunLimit;
}

export function registerPendingTestRun(runId: string, userId: string): void {
  let set = pendingByUser.get(userId);
  if (!set) {
    set = new Set();
    pendingByUser.set(userId, set);
  }
  set.add(runId);
}

export function releasePendingTestRun(runId: string): void {
  for (const [userId, set] of pendingByUser) {
    if (set.delete(runId) && set.size === 0) {
      pendingByUser.delete(userId);
      return;
    }
  }
}

/**
 * Derives the semantic outcome of a finished run from its real results. Runs
 * that never executed any test (sandbox never started, cancelled while
 * queued) are reported as INFRASTRUCTURE_ERROR / CANCELLED rather than as a
 * 0/100 score.
 */
export function deriveOutcome(state: string, info: TestRunInfo, errorCode?: string): RunOutcome {
  if (state === "destroyed") return "CANCELLED";
  if (state === "failed") {
    return errorCode === "EXTENSION_LOAD_FAILED" ? "FAILED" : "INFRASTRUCTURE_ERROR";
  }
  if (state === "timeout") return "TIMEOUT";
  if (info.completed === 0) return "INFRASTRUCTURE_ERROR";
  if (info.failed > 0 || info.error > 0) return "FAILED";
  if (info.timeout > 0) return "TIMEOUT";
  if (info.warning > 0) return "WARNING";
  if (info.passed === 0 && info.skipped > 0) return "SKIPPED";
  return "PASSED";
}

export interface PersistenceOptions {
  /** Phase 6 job id: stage/events are mirrored into job_events for durable SSE. */
  jobId?: string;
  /** Use DB quota reservations instead of the legacy in-memory map. */
  useReservations?: boolean;
  /**
   * Called for failed runs that never executed a test. Returning true keeps the
   * run queued (the job system will retry) instead of finalizing it.
   */
  shouldRetry?: (errorCode: string | undefined) => boolean;
}

export function createTestRunPersistence(options: PersistenceOptions = {}): TestRunPersistenceHooks {
  const mirror = (runId: string, kind: string, payload: unknown, stage?: string | null) => {
    if (!options.jobId) return;
    try {
      appendJobEvent({ jobId: options.jobId, kind, stage: stage ?? null, payload });
    } catch {
      // Event mirroring is best-effort; the run itself is the source of truth.
    }
  };

  return {
    onStage(snap: TestRunSnapshot, stage: TestRunStage): void {
      try {
        updateTestRunStage(snap.runId, { stage });
      } catch {
        // Ignore: status updates below keep the row consistent.
      }
      mirror(snap.runId, "stage", { type: "stage", stage, timestamp: Date.now() }, stage);
    },

    onEvent(snap: TestRunSnapshot, event: string): void {
      if (!options.jobId) return;
      try {
        const parsed = JSON.parse(event) as { type?: string };
        if (parsed.type === "stage") return; // already mirrored by onStage
        mirror(snap.runId, "event", parsed);
      } catch {
        // Ignore malformed events.
      }
    },

    onStatus(snap: TestRunSnapshot, info: TestRunInfo): void {
      const row = getTestRunById(snap.runId);
      if (!row) return;
      if (info.state === "running") {
        if (row.status !== "running") {
          updateTestRunStarted(snap.runId);
          // The sandbox actually started: charge the quota exactly once.
          if (options.useReservations) {
            const consumed = consumeReservationForResource(snap.runId);
            if (!consumed) {
              logger.debug("quota.reservation_already_settled", { runId: snap.runId });
            }
          } else if (pendingByUser.get(row.user_id)?.has(snap.runId)) {
            pendingByUser.get(row.user_id)?.delete(snap.runId);
            if (pendingByUser.get(row.user_id)?.size === 0) pendingByUser.delete(row.user_id);
            recordUsage(row.user_id, "test_run");
          }
        }
      } else {
        updateTestRunStatus(snap.runId, info.state);
      }
      mirror(snap.runId, "state", { type: "state", state: info.state, stage: info.stage, reason: info.reason }, info.stage ?? null);
    },

    onFinished(snap: TestRunSnapshot, info: TestRunInfo): void {
      const row = getTestRunById(snap.runId);
      if (!row) return;
      if (info.state === "failed" && !snap.startedAt && info.completed === 0 && options.shouldRetry?.(snap.errorCode)) {
        // Transient infrastructure failure before any test ran: keep the run
        // queued for the retry attempt. The quota reservation stays open and is
        // only released when the final attempt gives up.
        const reason = "Retrying after a temporary infrastructure problem.";
        requeueTestRunForRetry(snap.runId, reason);
        mirror(snap.runId, "state", { type: "state", state: "queued", stage: "Queued", retry: true, errorCode: snap.errorCode ?? null, reason }, "Queued");
        releasePendingTestRun(snap.runId);
        recordMetric("test_run.retry_deferred", 1, { errorCode: snap.errorCode ?? "unknown" });
        return;
      }
      const extension = row.extension_id ? getOwnedExtension(row.user_id, row.extension_id) : null;
      const outcome = deriveOutcome(info.state, info, snap.errorCode);
      const resultJson = exportTestResults({
        runId: snap.runId,
        extensionName: extension?.name,
        extensionVersion: extension?.version ?? undefined,
        results: snap.results as TestResult[],
        diagnostics: snap.diagnostics as DiagnosticFinding[],
        score: snap.score as TestScore,
        timestamps: {
          createdAt: snap.createdAt,
          startedAt: snap.startedAt,
          finishedAt: snap.finishedAt,
        },
      });
      const notExecuted = outcome === "INFRASTRUCTURE_ERROR" || outcome === "CANCELLED";
      const finalJson = {
        ...resultJson,
        // Full per-test results (screenshot bytes are never part of results;
        // evidence only carries labels). The web tier serves finished runs
        // from this row, so the complete Phase 4 shape must be persisted.
        results: (snap.results as TestResult[]).map(publicResult),
        score: notExecuted
          ? {
              ...(resultJson.score as Record<string, unknown>),
              basis: `No automated tests were executed${snap.reason ? `: ${snap.reason}` : "."}`,
            }
          : resultJson.score,
        outcome,
        errorCode: snap.errorCode ?? null,
        runtime: {
          status: notExecuted ? "not-executed" : "executed",
          sandboxStarted: Boolean(snap.startedAt),
        },
      };

      transaction(getDb(), () => {
        saveTestRunFinal({
          id: snap.runId,
          status: info.state,
          score: info.score,
          total: info.total,
          passed: info.passed,
          failed: info.failed,
          warnings: info.warning,
          skipped: info.skipped,
          timeout: info.timeout,
          errorCount: info.error,
          completedAt: snap.finishedAt ?? Date.now(),
          resultJson: JSON.stringify(finalJson),
          diagnosticsJson: JSON.stringify(snap.diagnostics),
          eventsJson: JSON.stringify(snap.events.slice(-200)),
          outcome,
          errorCode: snap.errorCode ?? null,
          reason: snap.reason ?? null,
        });
        if (options.useReservations && !snap.startedAt) {
          // The sandbox never started: the reservation must not be charged.
          releaseReservationForResource(snap.runId);
        }
        if (row.extension_id) {
          markExtensionTested({ id: row.extension_id, status: outcome.toLowerCase() });
        }
      });
      releasePendingTestRun(snap.runId);
      recordMetric("test_run.finished", 1, { outcome });
      logger.info("test_run.finished", {
        runId: snap.runId,
        userId: row.user_id,
        jobId: options.jobId,
        result: outcome,
        errorCode: snap.errorCode,
        durationMs: snap.finishedAt && snap.startedAt ? snap.finishedAt - snap.startedAt : undefined,
      });
      mirror(
        snap.runId,
        "finished",
        { type: "finished", state: info.state, outcome, errorCode: snap.errorCode ?? null, reason: info.reason },
        "Completed",
      );
    },
  };
}

/** Used by the create API after TestRunManager.create succeeds (legacy in-process flow). */
export function persistNewTestRun(input: {
  runId: string;
  userId: string;
  extensionId: string | null;
  createdAt?: number;
}): void {
  createTestRun({
    userId: input.userId,
    extensionId: input.extensionId,
    status: "idle",
    runId: input.runId,
    createdAt: input.createdAt,
  });
}

/** Strips anything that must not leave the worker (screenshot payload details). */
function publicResult(result: TestResult): TestResult {
  return {
    ...result,
    evidence: result.evidence.map((item) => (item.kind === "screenshot" ? { ...item, detail: "Screenshot captured." } : item)),
  };
}
