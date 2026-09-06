import type { TestRunRow } from "@/lib/db/schema/types";

/**
 * Phase 15 CI status mapping shared by the /api/v1/tests endpoints.
 *
 * The CI contract exposes exactly QUEUED / STARTING / RUNNING / COMPLETED /
 * FAILED / TIMEOUT / CANCELLED (§53). Internal states map deterministically;
 * infrastructure errors surface as FAILED (never success). Exit codes follow
 * §86: only COMPLETED exits 0; CANCELLED is 130; everything else is 1.
 */

export function ciRunStatus(run: TestRunRow): { status: string; detail: string | null } {
  switch (run.status) {
    case "queued":
    case "idle":
      return { status: "QUEUED", detail: null };
    case "preparing":
    case "starting":
      return { status: "STARTING", detail: null };
    case "running":
    case "stopping":
      return { status: "RUNNING", detail: null };
    default:
      break;
  }
  switch (run.outcome) {
    case "PASSED":
    case "SKIPPED":
    case "WARNING":
      return { status: "COMPLETED", detail: run.outcome };
    case "TIMEOUT":
      return { status: "TIMEOUT", detail: run.reason ?? null };
    case "CANCELLED":
      return { status: "CANCELLED", detail: run.reason ?? null };
    case "FAILED":
      return { status: "FAILED", detail: run.reason ?? null };
    default:
      // INFRASTRUCTURE_ERROR / ERROR never surface as success.
      return { status: "FAILED", detail: run.outcome ?? run.reason ?? "ERROR" };
  }
}

export function ciRunExitCode(status: string): number {
  if (status === "COMPLETED") return 0;
  if (status === "CANCELLED") return 130;
  return 1;
}

export function ciRunView(run: TestRunRow) {
  const mapped = ciRunStatus(run);
  return {
    id: run.id,
    testId: run.saved_test_id,
    testVersion: run.saved_test_version,
    status: mapped.status,
    detail: mapped.detail,
    browser: run.browser_id ?? "chromium",
    createdAt: new Date(run.created_at).toISOString(),
    startedAt: run.started_at ? new Date(run.started_at).toISOString() : null,
    finishedAt: run.completed_at ? new Date(run.completed_at).toISOString() : null,
    totals: { total: run.total, passed: run.passed, failed: run.failed, warnings: run.warnings, skipped: run.skipped },
    exitCode: ciRunExitCode(mapped.status),
  };
}
