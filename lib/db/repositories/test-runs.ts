import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { TestRunRow } from "../schema/types";

export type TestRunFilter =
  | "all"
  | "passed"
  | "failed"
  | "warnings"
  | "running"
  | "cancelled";

export interface TestRunWithExtension extends TestRunRow {
  extensionName: string | null;
  extensionVersion: string | null;
}

/**
 * Run outcomes (Phase 6). `status` keeps the Phase 4 lifecycle vocabulary for
 * backwards compatibility; `outcome` carries the final semantic result.
 */
export const RUN_OUTCOMES = [
  "PASSED",
  "FAILED",
  "WARNING",
  "SKIPPED",
  "TIMEOUT",
  "INFRASTRUCTURE_ERROR",
  "CANCELLED",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Live pipeline stages shown to users. Never a fabricated percentage. */
export const RUN_STAGES = [
  "Queued",
  "Preparing",
  "Starting sandbox",
  "Starting Chromium",
  "Loading extension",
  "Running tests",
  "Collecting evidence",
  "Generating report",
  "Completed",
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const ACTIVE_RUN_STATUSES = ["idle", "queued", "preparing", "starting", "running", "stopping"] as const;

export function createTestRun(input: {
  userId: string;
  extensionId: string | null;
  status: string;
  runId?: string;
  createdAt?: number;
  packageId?: string | null;
  jobId?: string | null;
  stage?: string | null;
  total?: number;
}): TestRunRow {
  const db = getDb();
  const now = input.createdAt ?? Date.now();
  const id = input.runId ?? generateDbId("run");
  db.prepare(
    `INSERT INTO test_runs
      (id, user_id, extension_id, status, created_at, updated_at, package_id, job_id, stage, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.extensionId,
    input.status,
    now,
    now,
    input.packageId ?? null,
    input.jobId ?? null,
    input.stage ?? null,
    input.total ?? 0,
  );
  return getTestRunById(id)!;
}

export function updateTestRunStage(id: string, input: { status?: string; stage: string | null; reason?: string | null }): void {
  const db = getDb();
  if (input.status) {
    db.prepare("UPDATE test_runs SET status = ?, stage = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?").run(
      input.status,
      input.stage,
      input.reason ?? null,
      Date.now(),
      id,
    );
  } else {
    db.prepare("UPDATE test_runs SET stage = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?").run(
      input.stage,
      input.reason ?? null,
      Date.now(),
      id,
    );
  }
}

export function attachJobToTestRun(runId: string, jobId: string): void {
  getDb().prepare("UPDATE test_runs SET job_id = ?, updated_at = ? WHERE id = ?").run(jobId, Date.now(), runId);
}

/**
 * Finalizes a run that never produced real results (sandbox unavailable,
 * cancelled, worker crash). Counts stay at zero and `score` stays 0, but the
 * `outcome`/`error_code` columns make it explicit that no tests were executed,
 * so no UI ever presents this as a 0/100 result.
 */
export function finalizeTestRunWithoutResults(input: {
  id: string;
  status: string;
  outcome: RunOutcome;
  errorCode: string | null;
  reason: string | null;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE test_runs SET status = ?, outcome = ?, error_code = ?, reason = ?, stage = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE id = ? AND status NOT IN ('completed')`,
    )
    .run(input.status, input.outcome, input.errorCode, input.reason, "Completed", now, now, input.id);
}

/**
 * Puts a run back in the queue after a transient infrastructure failure so a
 * retry attempt can execute it. Never touches runs that already produced
 * results.
 */
export function requeueTestRunForRetry(id: string, reason: string): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE test_runs SET status = 'queued', stage = 'Queued', outcome = NULL, error_code = NULL, reason = ?,
              started_at = NULL, completed_at = NULL, updated_at = ?
       WHERE id = ? AND status NOT IN ('completed','timeout','destroyed')`,
    )
    .run(reason, now, id);
  return res.changes > 0;
}

/** Client-safe projection for list endpoints (no token hash, no large JSON blobs). */
export function toTestRunListItem(row: TestRunWithExtension): Record<string, unknown> {
  return {
    id: row.id,
    extension_id: row.extension_id,
    status: row.status,
    stage: row.stage ?? null,
    outcome: row.outcome ?? null,
    error_code: row.error_code ?? null,
    reason: row.reason ?? null,
    score: row.score,
    total: row.total,
    passed: row.passed,
    failed: row.failed,
    warnings: row.warnings,
    skipped: row.skipped,
    timeout: row.timeout,
    error_count: row.error_count,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    extensionName: row.extensionName ?? null,
    extensionVersion: row.extensionVersion ?? null,
  };
}

export function listActiveTestRunsForUser(userId: string): TestRunRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM test_runs WHERE user_id = ? AND status IN ('idle','queued','preparing','starting','running','stopping') ORDER BY created_at ASC",
    )
    .all(userId) as unknown as TestRunRow[];
}

export function countActiveTestRunsForUser(userId: string): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS total FROM test_runs WHERE user_id = ? AND status IN ('idle','queued','preparing','starting','running','stopping')",
      )
      .get(userId) as { total: number }
  ).total;
}

export function listStaleActiveTestRuns(olderThan: number): TestRunRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM test_runs WHERE status IN ('idle','queued','preparing','starting','running','stopping') AND updated_at < ?",
    )
    .all(olderThan) as unknown as TestRunRow[];
}

export function listTestRunsForPackage(packageId: string): TestRunRow[] {
  return getDb().prepare("SELECT * FROM test_runs WHERE package_id = ?").all(packageId) as unknown as TestRunRow[];
}

export function deleteTestRunsBefore(before: number): number {
  return Number(
    getDb()
      .prepare(
        "DELETE FROM test_runs WHERE created_at < ? AND status NOT IN ('idle','queued','preparing','starting','running','stopping')",
      )
      .run(before).changes,
  );
}

export function getTestRunById(id: string): TestRunRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM test_runs WHERE id = ?").get(id) as
      | TestRunRow
      | undefined) ?? null
  );
}

export function getOwnedTestRun(userId: string, id: string): TestRunWithExtension | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT r.*, e.name AS extensionName, e.version AS extensionVersion
       FROM test_runs r
       LEFT JOIN extensions e ON e.id = r.extension_id
       WHERE r.id = ? AND r.user_id = ?`,
    )
    .get(id, userId) as
    | (TestRunRow & { extensionName: string | null; extensionVersion: string | null })
    | undefined;
  return row ?? null;
}

export function updateTestRunStatus(id: string, status: string): void {
  const db = getDb();
  db.prepare(`UPDATE test_runs SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    Date.now(),
    id,
  );
}

export function updateTestRunStarted(id: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE test_runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`,
  ).run(Date.now(), Date.now(), id);
}

export function saveTestRunFinal(input: {
  id: string;
  status: string;
  score: number;
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  timeout: number;
  errorCount: number;
  completedAt: number;
  resultJson: string;
  diagnosticsJson: string | null;
  eventsJson: string | null;
  outcome?: RunOutcome | null;
  errorCode?: string | null;
  reason?: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `UPDATE test_runs SET
       status = ?, score = ?, total = ?, passed = ?, failed = ?, warnings = ?,
       skipped = ?, timeout = ?, error_count = ?, completed_at = ?,
       result_json = ?, diagnostics_json = ?, events_json = ?, updated_at = ?,
       outcome = COALESCE(?, outcome), error_code = COALESCE(?, error_code), reason = COALESCE(?, reason), stage = 'Completed'
     WHERE id = ?`,
  ).run(
    input.status,
    input.score,
    input.total,
    input.passed,
    input.failed,
    input.warnings,
    input.skipped,
    input.timeout,
    input.errorCount,
    input.completedAt,
    input.resultJson,
    input.diagnosticsJson,
    input.eventsJson,
    Date.now(),
    input.outcome ?? null,
    input.errorCode ?? null,
    input.reason ?? null,
    input.id,
  );
}

export function listTestRuns(
  userId: string,
  input: { page: number; limit: number; filter?: TestRunFilter; search?: string },
): { items: TestRunWithExtension[]; total: number } {
  const db = getDb();
  const where: string[] = ["r.user_id = ?"];
  const params: string[] = [userId];
  switch (input.filter ?? "all") {
    case "passed":
      where.push("r.status = 'completed' AND r.failed = 0 AND r.error_count = 0 AND r.timeout = 0");
      break;
    case "failed":
      where.push("(r.status = 'failed' OR r.failed > 0 OR r.error_count > 0 OR r.timeout > 0)");
      break;
    case "warnings":
      where.push("r.warnings > 0");
      break;
    case "running":
      where.push("r.status IN ('idle','queued','preparing','starting','running','stopping')");
      break;
    case "cancelled":
      where.push("(r.status = 'destroyed' OR r.outcome = 'CANCELLED')");
      break;
  }
  if (input.search?.trim()) {
    const term = `%${input.search.trim()}%`;
    where.push("(e.name LIKE ? OR r.id LIKE ?)");
    params.push(term, term);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM test_runs r LEFT JOIN extensions e ON e.id = r.extension_id ${whereSql}`,
      )
      .get(...params) as { total: number }
  ).total;

  const items = db
    .prepare(
      `SELECT r.*, e.name AS extensionName, e.version AS extensionVersion
       FROM test_runs r
       LEFT JOIN extensions e ON e.id = r.extension_id
       ${whereSql}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, input.limit, (input.page - 1) * input.limit) as unknown as TestRunWithExtension[];
  return { items, total };
}

export function countTestRuns(userId: string): number {
  const db = getDb();
  return (
    db.prepare("SELECT COUNT(*) AS total FROM test_runs WHERE user_id = ?").get(userId) as {
      total: number;
    }
  ).total;
}

export function countRunsForExtension(extensionId: string): number {
  const db = getDb();
  return (
    db.prepare("SELECT COUNT(*) AS total FROM test_runs WHERE extension_id = ?").get(extensionId) as {
      total: number;
    }
  ).total;
}

export function listTestRunsForExtension(
  extensionId: string,
  limit = 10,
): TestRunWithExtension[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT r.*, e.name AS extensionName, e.version AS extensionVersion
       FROM test_runs r
       LEFT JOIN extensions e ON e.id = r.extension_id
       WHERE r.extension_id = ?
       ORDER BY r.created_at DESC
       LIMIT ?`,
    )
    .all(extensionId, limit) as unknown as TestRunWithExtension[];
}
