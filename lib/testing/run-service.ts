import "server-only";
import { timingSafeEqual } from "node:crypto";
import { getDb, transaction } from "@/lib/db/client";
import { attachJobToTestRun, createTestRun, getTestRunById, countActiveTestRunsForUser } from "@/lib/db/repositories/test-runs";
import { getJobById, getJobForResource, listJobEvents, queuePosition, type JobRow } from "@/lib/db/repositories/jobs";
import { releaseReservationForResource, reserveQuota } from "@/lib/db/repositories/quota";
import { getMaxConcurrentRuns, hasPriorityExecution } from "@/lib/billing/entitlements";
import { attachPackageToExtension, touchPackage } from "@/lib/db/repositories/packages";
import { enqueueJob, cancelJob } from "@/lib/jobs/queue";
import { notifyEmbeddedWorker } from "@/lib/jobs/runtime";
import { getConfig } from "@/lib/config/env";
import { AppError, isErrorCode } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { hashToken } from "@/lib/auth/tokens";
import { generateSessionToken } from "@/lib/runtime/ids";
import { discoverTests } from "./registry";
import { summarizeResults } from "./results";
import type { TestRunRow } from "@/lib/db/schema/types";
import type { ExtensionAnalysis } from "@/types/extension";
import type {
  DiagnosticFinding,
  TestResult,
  TestRunInfo,
  TestRunOutcome,
  TestRunStage,
  TestRunState,
  TestScore,
} from "./types";

/**
 * Phase 6 test-run service used by the web process.
 *
 * Creating a run is a single transaction: quota reservation + run row + job
 * row (+ per-user concurrency check). Execution happens in the worker; every
 * read below is served from the database so page refreshes, reconnects and
 * web restarts never lose a run.
 */

const ACTIVE_STATES: TestRunState[] = ["idle", "queued", "preparing", "starting", "running", "stopping"];

export interface CreateRunResult {
  runId: string;
  token: string;
  jobId: string;
  suite: { total: number };
  extensionId: string | null;
  packageId: string;
}

export function createQueuedTestRun(input: {
  userId: string;
  packageId: string;
  analysis: ExtensionAnalysis;
  extensionId: string | null;
  testUrl?: string;
}): CreateRunResult {
  const config = getConfig();
  const { tests } = discoverTests(input.analysis);
  const token = generateSessionToken();

  const created = transaction(getDb(), () => {
    // Plan entitlements are read inside the transaction so a concurrent
    // downgrade cannot be raced; JOB_MAX_QUEUED_PER_USER remains the floor.
    const maxActive = Math.max(getMaxConcurrentRuns(input.userId), config.jobs.maxQueuedPerUser);
    const active = countActiveTestRunsForUser(input.userId);
    if (active >= maxActive) {
      throw new AppError("CONCURRENCY_LIMIT");
    }
    const run = createTestRun({
      userId: input.userId,
      extensionId: input.extensionId,
      status: "queued",
      stage: "Queued",
      packageId: input.packageId,
      total: tests.length,
    });
    // Reservation first: throws QuotaExceededError and rolls everything back.
    const reservation = reserveQuota({ userId: input.userId, kind: "test_run", resourceId: run.id });
    const { job } = enqueueJob({
      type: "AUTOMATED_TEST",
      userId: input.userId,
      payload: {
        runId: run.id,
        packageId: input.packageId,
        extensionId: input.extensionId,
        testUrl: input.testUrl,
        testIds: tests.map((test) => test.id),
        reservationId: reservation.id,
      },
      resourceType: "test_run",
      resourceId: run.id,
      idempotencyKey: `test_run:${run.id}`,
      maxActivePerUser: maxActive,
      // Plans with priority execution are claimed ahead of the default queue.
      priority: hasPriorityExecution(input.userId) ? 10 : 0,
    });
    attachJobToTestRun(run.id, job.id);
    getDb()
      .prepare("UPDATE quota_reservations SET job_id = ? WHERE id = ?")
      .run(job.id, reservation.id);
    // Live-access token (legacy Phase 4 clients): only the hash is stored.
    getDb().prepare("UPDATE test_runs SET access_token_hash = ? WHERE id = ?").run(hashToken(token), run.id);
    touchPackage(input.packageId);
    if (input.extensionId) attachPackageToExtension(input.packageId, input.extensionId);
    return { run, job };
  });

  notifyEmbeddedWorker();
  recordMetric("test_run.queued", 1);
  logger.info("test_run.queued", { userId: input.userId, runId: created.run.id, jobId: created.job.id, total: tests.length });
  return {
    runId: created.run.id,
    token,
    jobId: created.job.id,
    suite: { total: tests.length },
    extensionId: input.extensionId,
    packageId: input.packageId,
  };
}

/**
 * Access control for live run endpoints: the session user must own the run,
 * or present the per-run token issued at creation (legacy Phase 4 clients).
 */
export function resolveAccessibleRun(userId: string, runId: string, token: string | null): TestRunRow {
  const run = getTestRunById(runId);
  if (!run) throw new AppError("NOT_FOUND", { message: "Test run was not found." });
  if (run.user_id === userId) return run;
  if (token && tokenMatches(run, token)) return run;
  throw new AppError("NOT_FOUND", { message: "Test run was not found." });
}

function tokenMatches(run: TestRunRow, token: string): boolean {
  if (!run.access_token_hash || token.length < 16) return false;
  const expected = Buffer.from(run.access_token_hash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function jobForRun(run: TestRunRow): JobRow | null {
  if (run.job_id) return getJobById(run.job_id);
  return getJobForResource("test_run", run.id);
}

/** Builds the Phase 4 `TestRunInfo` shape from persisted state. */
export function buildRunInfo(run: TestRunRow): TestRunInfo {
  const job = jobForRun(run);
  const parsed = parseResults(run);
  const summary = summarizeResults(parsed.results);
  const state = normalizeState(run.status);
  const stage = (run.stage as TestRunStage | null) ?? (state === "queued" ? "Queued" : undefined);
  const outcome = run.outcome && ["PASSED", "FAILED", "WARNING", "SKIPPED", "TIMEOUT", "INFRASTRUCTURE_ERROR", "CANCELLED"].includes(run.outcome)
    ? (run.outcome as TestRunOutcome)
    : undefined;
  return {
    runId: run.id,
    state,
    stage,
    outcome,
    errorCode: run.error_code && isErrorCode(run.error_code) ? run.error_code : undefined,
    jobId: job?.id,
    queuePosition: job && (job.status === "queued" || job.status === "retrying") ? queuePosition(job) ?? undefined : undefined,
    createdAt: run.created_at,
    startedAt: run.started_at ?? undefined,
    finishedAt: run.completed_at ?? undefined,
    total: run.total,
    completed: parsed.results.length,
    passed: run.passed || summary.passed,
    failed: run.failed || summary.failed,
    warning: run.warnings || summary.warning,
    skipped: run.skipped || summary.skipped,
    timeout: run.timeout || summary.timeout,
    error: run.error_count || summary.error,
    score: run.score,
    reason: run.reason ?? undefined,
  };
}

function normalizeState(status: string): TestRunState {
  const known: TestRunState[] = ["idle", "queued", "preparing", "starting", "running", "completed", "failed", "timeout", "stopping", "destroyed"];
  return (known as string[]).includes(status) ? (status as TestRunState) : "queued";
}

export function parseResults(run: TestRunRow): { results: TestResult[]; score: TestScore | null; diagnostics: DiagnosticFinding[] } {
  if (!run.result_json) return { results: [], score: null, diagnostics: [] };
  try {
    const parsed = JSON.parse(run.result_json) as {
      results?: TestResult[];
      tests?: LegacyExportedTest[];
      score?: Partial<TestScore>;
      diagnostics?: DiagnosticFinding[];
    };
    const results = Array.isArray(parsed.results)
      ? parsed.results
      : Array.isArray(parsed.tests)
        ? parsed.tests.map(fromLegacyExportedTest)
        : [];
    const score: TestScore | null = parsed.score
      ? {
          total: typeof parsed.score.total === "number" ? parsed.score.total : run.score,
          passed: run.passed,
          failed: run.failed,
          warning: run.warnings,
          skipped: run.skipped,
          timeout: run.timeout,
          error: run.error_count,
          categories: Array.isArray(parsed.score.categories) ? parsed.score.categories : [],
          basis: typeof parsed.score.basis === "string" ? parsed.score.basis : "",
        }
      : null;
    return { results, score, diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [] };
  } catch {
    return { results: [], score: null, diagnostics: [] };
  }
}

/** Shape written by Phase 5 (`exportTestResults().tests`) before full results were persisted. */
interface LegacyExportedTest {
  testId: string;
  name: string;
  status: TestResult["status"];
  category: TestResult["category"];
  duration: number;
  startedAt: number;
  finishedAt: number;
  assertions?: Array<{ type: string; passed: boolean; message: string }>;
  evidence?: Array<{ kind: TestResult["evidence"][number]["kind"]; label: string }>;
  errors?: string[];
  warnings?: string[];
}

function fromLegacyExportedTest(test: LegacyExportedTest): TestResult {
  return {
    testId: test.testId,
    name: test.name,
    description: "",
    category: test.category,
    status: test.status,
    duration: test.duration,
    startedAt: test.startedAt,
    finishedAt: test.finishedAt,
    steps: [],
    assertions: (test.assertions ?? []).map((assertion) => ({
      assertion: { type: assertion.type } as TestResult["assertions"][number]["assertion"],
      passed: assertion.passed,
      message: assertion.message,
    })),
    evidence: (test.evidence ?? []).map((item, index) => ({ id: `legacy-${index}`, timestamp: test.finishedAt, kind: item.kind, label: item.label })),
    errors: test.errors ?? [],
    warnings: test.warnings ?? [],
  };
}

/** Live events for a run: durable job events, falling back to the persisted tail. */
export function listRunEvents(run: TestRunRow, afterId = 0): Array<{ id: number; payload: string }> {
  const job = jobForRun(run);
  if (job) {
    return listJobEvents(job.id, afterId).map((row) => ({ id: row.id, payload: row.payload }));
  }
  if (afterId > 0 || !run.events_json) return [];
  try {
    const parsed = JSON.parse(run.events_json) as unknown;
    if (Array.isArray(parsed)) return parsed.map((event, index) => ({ id: index + 1, payload: String(event) }));
  } catch {
    // ignore
  }
  return [];
}

export function isRunActive(run: TestRunRow): boolean {
  return ACTIVE_STATES.includes(run.status as TestRunState);
}

/** Cancels a run idempotently: queued → cancelled now; running → worker stops the sandbox. */
export function cancelRun(run: TestRunRow): TestRunInfo {
  const job = jobForRun(run);
  if (!isRunActive(run)) return buildRunInfo(run);
  if (job) {
    const result = cancelJob(job.id);
    if (result.status === "cancelled") {
      transaction(getDb(), () => {
        getDb()
          .prepare(
            `UPDATE test_runs SET status = 'destroyed', outcome = 'CANCELLED', error_code = 'JOB_CANCELLED', reason = ?, stage = 'Completed',
                    completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND status NOT IN ('completed','failed','timeout','destroyed')`,
          )
          .run("Cancelled before the sandbox started.", Date.now(), Date.now(), run.id);
        releaseReservationForResource(run.id);
      });
    } else {
      getDb().prepare("UPDATE test_runs SET status = 'stopping', updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), run.id);
    }
    logger.info("test_run.cancel_requested", { runId: run.id, jobId: job.id, result: result.status ?? "unknown" });
  }
  return buildRunInfo(getTestRunById(run.id) ?? run);
}
