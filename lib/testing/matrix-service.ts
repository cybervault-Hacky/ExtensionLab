import "server-only";
import { getDb, transaction } from "@/lib/db/client";
import {
  createMatrixExecutionRow,
  createMatrixRunRow,
  getMatrixRunById,
  getOwnedMatrixRun,
  listExecutionsForMatrix,
  updateMatrixExecution,
  updateMatrixRun,
  listStaleActiveMatrixRuns,
  type MatrixExecutionStatus,
  type MatrixRunStatus,
  getOrgMatrixRun,
} from "@/lib/db/repositories/browser-matrix";
import { createTestRun, attachJobToTestRun, getTestRunById } from "@/lib/db/repositories/test-runs";
import { reserveQuota } from "@/lib/db/repositories/quota";
import { enqueueJob, cancelJob } from "@/lib/jobs/queue";
import { notifyEmbeddedWorker } from "@/lib/jobs/runtime";
import {
  canRunTestsN,
  canUseAdvancedSuites,
  canUseCrossBrowser,
  getBrowserConcurrency,
  getMaxBrowsersPerRun,
} from "@/lib/billing/entitlements";
import { getBrowserRuntimesHealth } from "@/lib/browsers/availability";
import { getBrowserProfile, getBrowserRegistryConfig } from "@/lib/browsers/registry";
import { isBrowserId, type BrowserId } from "@/lib/browsers/types";
import { buildMatrixComparison, type MatrixComparison } from "./comparison";
import { resolveSuite } from "./suites";
import { createReport } from "@/lib/db/repositories/reports";
import { redactSensitiveText, redactUrlShallow } from "@/lib/runtime/redact";
import { AppError } from "@/lib/observability/errors";
import { dispatchOrganizationEvent } from "@/lib/webhooks/dispatch";
import { logger, recordMetric } from "@/lib/observability/logger";
import type { NetworkEntryLike, RuntimeEventLike, TestResult } from "./types";
import type { ExtensionAnalysis } from "@/types/extension";

/**
 * Phase 9 browser-matrix orchestration.
 *
 * Matrix Job → Child Run (Chromium) / Child Run (Edge) / Child Run (Firefox).
 * Every child is a full Phase 6 execution: its own test_runs row, its own job,
 * its own disposable sandbox and its own quota reservation. The parent row
 * tracks aggregation only; it never shares browser state between browsers.
 *
 * Quota policy (deterministic, documented): one browser execution consumes one
 * `test_run` unit, so a 3-browser matrix reserves 3 units atomically.
 */

export interface CreateMatrixRunInput {
  userId: string;
  packageId: string;
  extensionId: string | null;
  browsers: string[];
  suiteId?: string | null;
  testUrl?: string;
  analysis: ExtensionAnalysis;
  idempotencyKey?: string | null;
  /** Phase 10: owning organization (personal workspace when absent). */
  organizationId?: string | null;
}

export interface CreateMatrixRunResult {
  matrixRunId: string;
  executions: Array<{ browserId: BrowserId; runId: string; jobId: string }>;
  suite: { id: string; name: string; total: number };
}

const TERMINAL_EXECUTION_STATES = ["completed", "failed", "timeout", "destroyed"];

export async function createMatrixRun(input: CreateMatrixRunInput): Promise<CreateMatrixRunResult> {
  // 1. Validate browser ids: known, unique, non-empty.
  const requested = [...new Set(input.browsers)];
  if (requested.length === 0) throw new AppError("INVALID_INPUT", { message: "Select at least one browser." });
  if (requested.some((id) => !isBrowserId(id))) {
    throw new AppError("BROWSER_NOT_SUPPORTED", { message: "One of the selected browsers is not supported." });
  }
  const browsers = requested as BrowserId[];

  // 2. Entitlements (server-authoritative; never trust client values).
  const registryLimits = getBrowserRegistryConfig().limits;
  const crossBrowser = browsers.length > 1 || browsers.some((id) => id !== "chromium");
  if (crossBrowser) {
    const verdict = canUseCrossBrowser(input.userId);
    if (!verdict.allowed) {
      throw new AppError("PAYMENT_REQUIRED", { message: verdict.reason === "plan" ? verdict.message : undefined });
    }
  }
  const planMaxBrowsers = getMaxBrowsersPerRun(input.userId);
  const maxBrowsers = Math.min(planMaxBrowsers, registryLimits.maxBrowsersPerMatrix);
  if (browsers.length > maxBrowsers) {
    throw new AppError("MATRIX_LIMIT", {
      message: `Your plan allows up to ${maxBrowsers} browser${maxBrowsers === 1 ? "" : "s"} per run.`,
    });
  }

  // 3. Resolve the suite (validates dependencies + applicability).
  const resolved = resolveSuite(input.suiteId, input.analysis);
  if (resolved.advanced) {
    const verdict = canUseAdvancedSuites(input.userId);
    if (!verdict.allowed) {
      throw new AppError("PAYMENT_REQUIRED", { message: verdict.reason === "plan" ? verdict.message : undefined });
    }
  }
  if (resolved.tests.length > registryLimits.maxMatrixTests) {
    throw new AppError("MATRIX_LIMIT", { message: `The selected suite exceeds the matrix test limit (${registryLimits.maxMatrixTests}).` });
  }

  // 4. Validate browser availability before enqueueing anything.
  const health = await getBrowserRuntimesHealth();
  const unavailable = browsers.filter((id) => !health[id]?.available);
  if (unavailable.length > 0) {
    throw new AppError("BROWSER_RUNTIME_UNAVAILABLE", {
      message: `Browser runtime unavailable: ${unavailable.join(", ")}. Build the runtime image first (see docs/BROWSERS.md).`,
    });
  }

  // 5. Quota: one unit per browser execution, checked once and re-verified
  //    atomically per child reservation inside the transaction.
  const quota = canRunTestsN(input.userId, browsers.length);
  if (!quota.allowed) {
    const limit = quota.reason === "quota" ? quota.quota.limit : 0;
    throw new AppError("QUOTA_EXCEEDED", {
      message: `A ${browsers.length}-browser matrix needs ${browsers.length} test-run units; your plan allows ${limit} per period.`,
    });
  }

  // 6. Create everything atomically (matrix + children + jobs + reservations).
  const created = transaction(getDb(), () => {
    const matrix = createMatrixRunRow({
      userId: input.userId,
      extensionId: input.extensionId,
      packageId: input.packageId,
      testSuiteId: resolved.suite.id,
      testSuiteName: resolved.suite.name,
      browsers,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    });
    const executions: CreateMatrixRunResult["executions"] = [];
    // Per-user browser parallelism, clamped by the deployment-wide matrix
    // concurrency ceiling (MAX_MATRIX_CONCURRENCY) — the smaller wins.
    const perUserCap = Math.min(
      Math.max(getBrowserConcurrency(input.userId), 1),
      Math.max(registryLimits.maxMatrixConcurrency, 1),
    );
    for (const browserId of browsers) {
      const profile = getBrowserProfile(browserId);
      const run = createTestRun({
        userId: input.userId,
        extensionId: input.extensionId,
        status: "queued",
        stage: "Queued",
        packageId: input.packageId,
        total: resolved.tests.length,
        browserId,
        engine: profile.engine,
        matrixRunId: matrix.id,
      });
      const reservation = reserveQuota({ userId: input.userId, kind: "test_run", resourceId: run.id });
      const { job } = enqueueJob({
        type: "AUTOMATED_TEST",
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        payload: {
          runId: run.id,
          packageId: input.packageId,
          extensionId: input.extensionId,
          testUrl: input.testUrl,
          testIds: resolved.tests.map((test) => test.id),
          reservationId: reservation.id,
          browserId,
          matrixRunId: matrix.id,
        },
        resourceType: "test_run",
        resourceId: run.id,
        idempotencyKey: `matrix:${matrix.id}:${browserId}`,
        maxActivePerUser: perUserCap,
      });
      attachJobToTestRun(run.id, job.id);
      getDb().prepare("UPDATE quota_reservations SET job_id = ? WHERE id = ?").run(job.id, reservation.id);
      createMatrixExecutionRow({
        matrixRunId: matrix.id,
        browserId,
        testRunId: run.id,
        jobId: job.id,
        engine: profile.engine,
      });
      executions.push({ browserId, runId: run.id, jobId: job.id });
    }
    return { matrix, executions };
  });

  notifyEmbeddedWorker();
  recordMetric("matrix.created", 1, { browsers: browsers.join(",") });
  logger.info("matrix.created", {
    userId: input.userId,
    matrixRunId: created.matrix.id,
    browsers,
    suiteId: resolved.suite.id,
    packageId: input.packageId,
  });
  return {
    matrixRunId: created.matrix.id,
    executions: created.executions,
    suite: { id: resolved.suite.id, name: resolved.suite.name, total: resolved.tests.length },
  };
}

// ---------------------------------------------------------------------------
// Child completion + finalization

export interface ExecutionEvidencePayload {
  consoleEvents: RuntimeEventLike[];
  network: NetworkEntryLike[];
  screenshotCount: number;
}

/** Bounded, redacted evidence stored per execution for comparison (no raw headers). */
export function buildExecutionEvidence(payload: ExecutionEvidencePayload): string {
  return JSON.stringify({
    schemaVersion: 1,
    consoleEvents: payload.consoleEvents.slice(-100).map((event) => ({
      level: String(event.level).slice(0, 16),
      message: redactSensitiveText(String(event.message)).slice(0, 500),
    })),
    network: payload.network.slice(-100).map((entry) => ({
      method: String(entry.method).slice(0, 16),
      url: redactUrlShallow(String(entry.url)).slice(0, 512),
      status: entry.status ?? null,
      resourceType: String(entry.resourceType).slice(0, 32),
      duration: entry.duration ?? 0,
    })),
    screenshotCount: payload.screenshotCount,
  });
}

/**
 * Records a finished child run on its execution row and finalizes the matrix
 * when every execution reached a terminal state. Idempotent.
 */
export function noteMatrixChildFinished(runId: string, evidence?: ExecutionEvidencePayload): void {
  const row = getTestRunById(runId);
  if (!row?.matrix_run_id) return;
  const executions = listExecutionsForMatrix(row.matrix_run_id);
  const execution = executions.find((entry) => entry.test_run_id === runId);
  if (!execution) return;
  const terminal = TERMINAL_EXECUTION_STATES.includes(row.status);
  if (!terminal) return; // retried/requeued jobs call this again when truly finished

  const alreadyFinal = execution.status !== "queued" && execution.status !== "running";
  updateMatrixExecution(execution.id, {
    status: mapRunStatusToExecution(row.status, row.outcome),
    outcome: row.outcome ?? null,
    errorCode: row.error_code ?? null,
    reason: row.reason ?? null,
    score: row.score,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    browserVersion: row.browser_version ?? null,
    evidenceJson: evidence ? buildExecutionEvidence(evidence) : execution.evidence_json,
    startedAt: row.started_at ?? null,
    finishedAt: row.completed_at ?? Date.now(),
  });
  if (!alreadyFinal) {
    recordMetric("matrix.execution_finished", 1, {
      browserId: execution.browser_id,
      outcome: row.outcome ?? "unknown",
    });
    logger.info("matrix.execution_finished", {
      matrixRunId: row.matrix_run_id,
      childRunId: runId,
      browserId: execution.browser_id,
      browserVersion: row.browser_version ?? undefined,
      result: row.outcome ?? row.status,
    });
  }

  const refreshed = listExecutionsForMatrix(row.matrix_run_id);
  const matrix = getMatrixRunById(row.matrix_run_id);
  if (!matrix || ["partial", "completed", "failed", "cancelled"].includes(matrix.status)) return;
  if (refreshed.every((entry) => entry.status !== "queued" && entry.status !== "running")) {
    finalizeMatrixRun(row.matrix_run_id);
  } else if (matrix.status === "queued") {
    updateMatrixRun(matrix.id, { status: "running", startedAt: matrix.started_at ?? Date.now() });
  }
}

function mapRunStatusToExecution(runStatus: string, outcome: string | null | undefined): MatrixExecutionStatus {
  if (outcome === "CANCELLED" || runStatus === "destroyed") return "cancelled";
  if (outcome === "INFRASTRUCTURE_ERROR") return "skipped";
  if (runStatus === "completed") return "completed";
  if (runStatus === "failed" || runStatus === "timeout") return "failed";
  return "failed";
}

/** Derives the aggregate matrix status from terminal executions. */
export function deriveMatrixStatus(
  executions: Array<{ status: string; outcome: string | null }>,
): MatrixRunStatus {
  const outcomes = executions.map((execution) => execution.outcome ?? "PENDING");
  const executed = outcomes.filter((outcome) => ["PASSED", "FAILED", "WARNING", "SKIPPED", "TIMEOUT"].includes(outcome));
  const passing = outcomes.filter((outcome) => outcome === "PASSED" || outcome === "WARNING");
  const failing = outcomes.filter((outcome) => outcome === "FAILED" || outcome === "TIMEOUT");
  const cancelled = outcomes.filter((outcome) => outcome === "CANCELLED");
  if (executions.length > 0 && cancelled.length === executions.length) return "cancelled";
  if (executed.length === 0) return cancelled.length > 0 ? "cancelled" : "failed";
  if (failing.length === 0 && executed.length === executions.length) return "completed";
  if (executed.length > 0) return "partial";
  return "failed";
}

/**
 * Finalizes a matrix run: computes the deterministic comparison, stores it,
 * generates the cross-browser report and sets the aggregate status. Idempotent;
 * safe to call from handlers, sweeps and API reads.
 */
export function finalizeMatrixRun(matrixRunId: string): { status: MatrixRunStatus; comparison: MatrixComparison } | null {
  const matrix = getMatrixRunById(matrixRunId);
  if (!matrix) return null;
  const executions = listExecutionsForMatrix(matrixRunId);
  if (executions.length === 0) return null;

  const engineByBrowser: Record<string, string> = {};
  for (const execution of executions) {
    engineByBrowser[execution.browser_id] = execution.engine ?? getBrowserProfile(execution.browser_id as BrowserId)?.engine ?? "";
  }

  const comparisonExecutions = executions.map((execution) => {
    const run = getTestRunById(execution.test_run_id);
    const parsed = run?.result_json ? (JSON.parse(run.result_json) as { results?: TestResult[] }) : null;
    const evidence = execution.evidence_json
      ? (JSON.parse(execution.evidence_json) as { consoleEvents?: RuntimeEventLike[]; network?: NetworkEntryLike[]; screenshotCount?: number })
      : {};
    const executed =
      Boolean(run?.outcome) &&
      run!.outcome !== "INFRASTRUCTURE_ERROR" &&
      run!.outcome !== "CANCELLED" &&
      !["failed", "timeout", "destroyed"].includes(run?.status ?? "");
    return {
      browserId: execution.browser_id,
      browserVersion: execution.browser_version ?? run?.browser_version ?? null,
      engine: execution.engine,
      displayName: getBrowserProfile(execution.browser_id as BrowserId)?.displayName ?? execution.browser_id,
      executed,
      outcome: (run?.outcome ?? (executed ? "FAILED" : "INFRASTRUCTURE_ERROR")) as never,
      score: run?.score ?? 0,
      durationMs: run?.started_at && run?.completed_at ? run.completed_at - run.started_at : null,
      results: parsed?.results ?? [],
      consoleEvents: evidence.consoleEvents ?? [],
      network: evidence.network ?? [],
      screenshotCount: evidence.screenshotCount ?? 0,
      errorCode: execution.error_code,
      reason: execution.reason,
    };
  });

  const requested = JSON.parse(matrix.browsers_json) as string[];
  const comparison = buildMatrixComparison({
    requestedBrowsers: requested,
    executions: comparisonExecutions,
    engineByBrowser,
  });

  const status = deriveMatrixStatus(
    executions.map((execution) => ({ status: execution.status, outcome: execution.outcome })),
  );

  // Cross-browser report (immutable once written; version metadata inside).
  let reportId = matrix.report_id;
  if (!reportId) {
    const report = createReport({
      userId: matrix.user_id,
      ...(matrix.organization_id ? { organizationId: matrix.organization_id } : {}),
      extensionId: matrix.extension_id,
      analysisSnapshotId: null,
      testRunId: null,
      title: `Cross-browser matrix — ${matrix.test_suite_name ?? matrix.test_suite_id}`,
      summary: comparison.compatibility.score === null
        ? "No browser executed any tests (insufficient execution data)."
        : `Compatibility score ${comparison.compatibility.score}/100 across ${requested.length} requested browser(s).`,
      healthScore: null,
      runtimeScore: comparison.compatibility.score,
      overallScore: comparison.compatibility.score,
      reportJson: JSON.stringify({
        kind: "cross-browser-matrix",
        schemaVersion: 1,
        matrixRunId: matrix.id,
        browsers: comparison.results.map((result) => ({
          browserId: result.browserId,
          version: result.browserVersion,
          engine: result.engine,
          status: result.status,
          executed: result.executed,
        })),
        compatibility: comparison.compatibility,
      }),
    });
    reportId = report.id;
  }

  updateMatrixRun(matrix.id, {
    status,
    compatibilityScore: comparison.compatibility.score,
    coverage: comparison.compatibility.coverage,
    comparisonJson: JSON.stringify(comparison),
    reportId,
    finishedAt: Date.now(),
    reason:
      status === "partial"
        ? "Some browsers completed successfully; others failed or were unavailable."
        : status === "cancelled"
          ? "Matrix run cancelled; completed browser results were preserved."
          : matrix.reason,
  });

  recordMetric("matrix.finalized", 1, { status, browsers: requested.join(",") });
  if (matrix.organization_id) {
    const terminal = status === "completed";
    dispatchOrganizationEvent(
      matrix.organization_id,
      terminal ? "browser_matrix.completed" : "browser_matrix.failed",
      { matrixRunId: matrix.id, organizationId: matrix.organization_id, status, compatibilityScore: comparison.compatibility.score },
    );
    if (reportId) {
      dispatchOrganizationEvent(matrix.organization_id, "report.created", {
        reportId,
        organizationId: matrix.organization_id,
        matrixRunId: matrix.id,
        compatibilityScore: comparison.compatibility.score,
      });
    }
  }
  logger.info("matrix.finalized", {
    matrixRunId: matrix.id,
    status,
    compatibilityScore: comparison.compatibility.score,
    coverage: comparison.compatibility.coverage,
    browsers: requested,
  });
  return { status, comparison };
}

// ---------------------------------------------------------------------------
// Reads, cancellation, sweeps

export interface MatrixRunView {
  matrixRun: {
    id: string;
    status: MatrixRunStatus;
    suiteId: string;
    suiteName: string | null;
    browsers: string[];
    compatibilityScore: number | null;
    coverage: number | null;
    reportId: string | null;
    reason: string | null;
    createdAt: number;
    updatedAt: number;
    finishedAt: number | null;
  };
  executions: Array<{
    browserId: string;
    displayName: string;
    engine: string | null;
    browserVersion: string | null;
    status: string;
    outcome: string | null;
    errorCode: string | null;
    reason: string | null;
    score: number | null;
    passed: number;
    failed: number;
    skipped: number;
    runId: string;
    jobId: string | null;
    createdAt: number;
    finishedAt: number | null;
  }>;
  comparison: MatrixComparison | null;
}

export function getMatrixRunView(userId: string, matrixRunId: string): MatrixRunView | null {
  const matrix = getOwnedMatrixRun(userId, matrixRunId);
  if (!matrix) return null;
  return buildMatrixRunView(matrix);
}

/** Phase 10: organization-scoped view for API-key callers. */
export function getMatrixRunViewForOrganization(organizationId: string, matrixRunId: string): MatrixRunView | null {
  const matrix = getOrgMatrixRun(organizationId, matrixRunId);
  if (!matrix) return null;
  return buildMatrixRunView(matrix);
}

function buildMatrixRunView(matrix: import("@/lib/db/schema/types").BrowserMatrixRunRow): MatrixRunView | null {
  let comparison: MatrixComparison | null = null;
  if (matrix.comparison_json) {
    try {
      comparison = JSON.parse(matrix.comparison_json) as MatrixComparison;
    } catch {
      comparison = null;
    }
  } else if (!["queued", "running"].includes(matrix.status)) {
    const finalized = finalizeMatrixRun(matrix.id);
    comparison = finalized?.comparison ?? null;
  }
  const executions = listExecutionsForMatrix(matrix.id).map((execution) => ({
    browserId: execution.browser_id,
    displayName: getBrowserProfile(execution.browser_id as BrowserId)?.displayName ?? execution.browser_id,
    engine: execution.engine,
    browserVersion: execution.browser_version,
    status: execution.status,
    outcome: execution.outcome,
    errorCode: execution.error_code,
    reason: execution.reason,
    score: execution.score,
    passed: execution.passed,
    failed: execution.failed,
    skipped: execution.skipped,
    runId: execution.test_run_id,
    jobId: execution.job_id,
    createdAt: execution.created_at,
    finishedAt: execution.finished_at,
  }));
  return {
    matrixRun: {
      id: matrix.id,
      status: matrix.status as MatrixRunStatus,
      suiteId: matrix.test_suite_id,
      suiteName: matrix.test_suite_name,
      browsers: JSON.parse(matrix.browsers_json) as string[],
      compatibilityScore: matrix.compatibility_score,
      coverage: matrix.coverage,
      reportId: matrix.report_id,
      reason: matrix.reason,
      createdAt: matrix.created_at,
      updatedAt: matrix.updated_at,
      finishedAt: matrix.finished_at,
    },
    executions,
    comparison,
  };
}

/**
 * Cancels a matrix run: pending child jobs are cancelled immediately, running
 * jobs stop cooperatively, already-completed browser results are preserved and
 * the matrix is finalized (usually as cancelled/partial).
 */
export function cancelMatrixRun(userId: string, matrixRunId: string): MatrixRunView | null {
  const matrix = getOwnedMatrixRun(userId, matrixRunId);
  if (!matrix) throw new AppError("NOT_FOUND", { message: "Matrix run was not found." });
  if (["completed", "failed", "cancelled", "partial"].includes(matrix.status)) {
    return getMatrixRunView(userId, matrixRunId);
  }
  const executions = listExecutionsForMatrix(matrix.id);
  for (const execution of executions) {
    if (["completed", "failed", "cancelled", "skipped"].includes(execution.status)) continue;
    if (execution.status === "queued" && execution.job_id) {
      const result = cancelJob(execution.job_id);
      if (result.status === "cancelled") {
        updateMatrixExecution(execution.id, { status: "cancelled", outcome: "CANCELLED", reason: "Cancelled while queued." });
      }
    } else if (execution.status === "running" && execution.job_id) {
      cancelJob(execution.job_id);
      updateMatrixExecution(execution.id, { status: "cancelled", outcome: "CANCELLED", reason: "Cancellation requested." });
    }
  }
  // Jobs already terminal in the jobs table but not yet reflected on the
  // execution rows are picked up by the finalize sweep below.
  sweepExecutionsFromRuns(matrix.id);
  const refreshed = listExecutionsForMatrix(matrix.id);
  if (refreshed.every((execution) => execution.status !== "queued" && execution.status !== "running")) {
    finalizeMatrixRun(matrix.id);
  } else {
    updateMatrixRun(matrix.id, { reason: "Cancellation requested." });
  }
  logger.info("matrix.cancel_requested", { userId, matrixRunId: matrix.id });
  recordMetric("matrix.cancelled", 1);
  return getMatrixRunView(userId, matrixRunId);
}

/** Reconciles execution rows against their (possibly finished) child runs. */
export function sweepExecutionsFromRuns(matrixRunId: string): void {
  for (const execution of listExecutionsForMatrix(matrixRunId)) {
    if (["completed", "failed", "cancelled", "skipped"].includes(execution.status)) continue;
    const run = getTestRunById(execution.test_run_id);
    if (!run || !TERMINAL_EXECUTION_STATES.includes(run.status)) continue;
    noteMatrixChildFinished(execution.test_run_id);
  }
}

/**
 * Safety net: finalizes matrix runs whose children all stopped without the
 * completion callback firing (worker crash paths), and enforces the matrix
 * timeout so a hung browser can never let a matrix run forever.
 */
export function sweepStaleMatrixRuns(now = Date.now()): number {
  const config = getBrowserRegistryConfig().limits;
  let touched = 0;
  for (const matrix of listStaleActiveMatrixRuns(now - 30_000)) {
    sweepExecutionsFromRuns(matrix.id);
    const executions = listExecutionsForMatrix(matrix.id);
    const stillActive = executions.some((execution) => execution.status === "queued" || execution.status === "running");
    if (!stillActive) {
      finalizeMatrixRun(matrix.id);
      touched += 1;
    } else if (now - matrix.created_at > config.matrixTimeoutMs) {
      for (const execution of executions) {
        if (execution.status === "queued" && execution.job_id) cancelJob(execution.job_id);
        if (["queued", "running"].includes(execution.status)) {
          updateMatrixExecution(execution.id, {
            status: "cancelled",
            outcome: "CANCELLED",
            reason: "Matrix timeout reached.",
          });
        }
      }
      finalizeMatrixRun(matrix.id);
      touched += 1;
      logger.warn("matrix.timeout_finalized", { matrixRunId: matrix.id, component: "matrix" });
    }
  }
  return touched;
}
