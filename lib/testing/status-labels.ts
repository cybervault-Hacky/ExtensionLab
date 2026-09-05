/**
 * Shared, client-safe presentation helpers for test-run status.
 *
 * Phase 6 distinguishes the lifecycle `status` (queued/running/…) from the
 * semantic `outcome` (PASSED/FAILED/…/INFRASTRUCTURE_ERROR/CANCELLED). UIs
 * must never present a score for runs where no tests were executed.
 */

export const ACTIVE_RUN_STATUSES = ["idle", "queued", "preparing", "starting", "running", "stopping"] as const;

export type BadgeTone = "success" | "error" | "warning" | "info" | "neutral";

export interface RunStatusLike {
  status: string;
  outcome?: string | null;
  error_code?: string | null;
  errorCode?: string | null;
  failed?: number;
  error_count?: number;
  error?: number;
  timeout?: number;
  warnings?: number;
  warning?: number;
}

export function isActiveRunStatus(status: string | undefined | null): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status ?? "");
}

/** True when the run produced real test results that a score can describe. */
export function runHasExecutedTests(run: RunStatusLike): boolean {
  const outcome = run.outcome ?? null;
  if (outcome === "INFRASTRUCTURE_ERROR" || outcome === "CANCELLED") return false;
  if (outcome) return true;
  // Legacy Phase 4/5 rows have no outcome column value.
  if (run.status === "completed") return true;
  if (run.status === "timeout") return true;
  return false;
}

export function runOutcomeLabel(run: RunStatusLike): string {
  const outcome = run.outcome ?? null;
  if (outcome) {
    switch (outcome) {
      case "PASSED":
        return "Passed";
      case "FAILED":
        return "Failed";
      case "WARNING":
        return "Warnings";
      case "SKIPPED":
        return "Skipped";
      case "TIMEOUT":
        return "Timeout";
      case "INFRASTRUCTURE_ERROR":
        return "Infrastructure error";
      case "CANCELLED":
        return "Cancelled";
    }
  }
  const status = run.status;
  if (status === "queued") return "Queued";
  if (status === "completed") {
    const failed = (run.failed ?? 0) + (run.error_count ?? run.error ?? 0) + (run.timeout ?? 0);
    if (failed > 0) return "Failed";
    if ((run.warnings ?? run.warning ?? 0) > 0) return "Warnings";
    return "Passed";
  }
  if (status === "failed") return "Failed";
  if (status === "timeout") return "Timeout";
  if (status === "destroyed") return "Cancelled";
  if (isActiveRunStatus(status)) return "Running";
  return status;
}

export function runOutcomeTone(run: RunStatusLike): BadgeTone {
  const label = runOutcomeLabel(run);
  switch (label) {
    case "Passed":
      return "success";
    case "Failed":
    case "Timeout":
      return "error";
    case "Warnings":
      return "warning";
    case "Infrastructure error":
      return "warning";
    case "Queued":
    case "Running":
      return "info";
    default:
      return "neutral";
  }
}

/** Human-readable score cell: hides scores that would be misleading. */
export function runScoreLabel(run: RunStatusLike & { score: number }): string {
  if (isActiveRunStatus(run.status)) return "—";
  return runHasExecutedTests(run) ? `${run.score}/100` : "n/a";
}

/** Long-form description for the live view header. */
export function describeRunState(input: {
  state?: string;
  stage?: string;
  outcome?: string;
  queuePosition?: number;
  reason?: string;
}): string {
  const { state, stage, outcome, queuePosition, reason } = input;
  if (!state) return "Loading run…";
  if (state === "queued") {
    return queuePosition && queuePosition > 1 ? `Queued · position ${queuePosition}` : "Queued · waiting for a worker";
  }
  if (isActiveRunStatus(state)) {
    if (state === "stopping") return "Stopping tests…";
    return stage ? `${stage}…` : "Preparing…";
  }
  if (outcome === "INFRASTRUCTURE_ERROR") return reason ? `Infrastructure error · ${reason}` : "Infrastructure error · no tests were executed";
  if (outcome === "CANCELLED") return "Cancelled";
  if (outcome === "TIMEOUT") return "Timed out";
  if (state === "completed") return "Completed";
  if (state === "failed") return reason ? `Failed · ${reason}` : "Failed";
  if (state === "timeout") return "Timed out";
  if (state === "destroyed") return "Cancelled";
  return state;
}
