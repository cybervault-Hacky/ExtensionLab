import { getDb, transaction } from "../client";
import { generateDbId } from "../ids";
import type { BrowserMatrixExecutionRow, BrowserMatrixRunRow } from "../schema/types";

/**
 * Phase 9 browser-matrix persistence.
 *
 * A matrix run owns one child execution per requested browser; each execution
 * owns exactly one test_runs row and one job row. Creation happens inside a
 * single transaction so quota reservations, run rows and jobs commit or roll
 * back together (see lib/testing/matrix-service.ts).
 */

export const MATRIX_RUN_STATUSES = [
  "queued",
  "running",
  "partial",
  "completed",
  "failed",
  "cancelled",
] as const;
export type MatrixRunStatus = (typeof MATRIX_RUN_STATUSES)[number];

export const MATRIX_EXECUTION_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type MatrixExecutionStatus = (typeof MATRIX_EXECUTION_STATUSES)[number];

export function createMatrixRunRow(input: {
  userId: string;
  extensionId: string | null;
  packageId: string;
  testSuiteId: string;
  testSuiteName: string | null;
  browsers: string[];
  runId?: string;
  organizationId?: string | null;
}): BrowserMatrixRunRow {
  const db = getDb();
  const now = Date.now();
  const id = input.runId ?? generateDbId("matrix");
  db.prepare(
    `INSERT INTO browser_matrix_runs
      (id, user_id, extension_id, package_id, test_suite_id, test_suite_name, browsers_json, status, created_at, updated_at, organization_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.extensionId,
    input.packageId,
    input.testSuiteId,
    input.testSuiteName,
    JSON.stringify(input.browsers),
    now,
    now,
    input.organizationId ?? null,
  );
  return getMatrixRunById(id)!;
}

/** Phase 10: organization-scoped matrix lookup (API-key paths). */
export function getOrgMatrixRun(organizationId: string, id: string): BrowserMatrixRunRow | null {
  const row = getDb().prepare("SELECT * FROM browser_matrix_runs WHERE id = ? AND organization_id = ?").get(id, organizationId);
  return (row as unknown as BrowserMatrixRunRow | undefined) ?? null;
}

export function createMatrixExecutionRow(input: {
  matrixRunId: string;
  browserId: string;
  testRunId: string;
  jobId: string | null;
  browserVersion?: string | null;
  engine?: string | null;
  executionId?: string;
}): BrowserMatrixExecutionRow {
  const db = getDb();
  const now = Date.now();
  const id = input.executionId ?? generateDbId("exec");
  db.prepare(
    `INSERT INTO browser_matrix_executions
      (id, matrix_run_id, browser_id, browser_version, engine, test_run_id, job_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(id, input.matrixRunId, input.browserId, input.browserVersion ?? null, input.engine ?? null, input.testRunId, input.jobId, now, now);
  return getExecutionById(id)!;
}

export function getMatrixRunById(id: string): BrowserMatrixRunRow | null {
  return (getDb().prepare("SELECT * FROM browser_matrix_runs WHERE id = ?").get(id) as BrowserMatrixRunRow | undefined) ?? null;
}

export function getOwnedMatrixRun(userId: string, id: string): BrowserMatrixRunRow | null {
  const row = getMatrixRunById(id);
  return row && row.user_id === userId ? row : null;
}

export function getExecutionById(id: string): BrowserMatrixExecutionRow | null {
  return (getDb().prepare("SELECT * FROM browser_matrix_executions WHERE id = ?").get(id) as BrowserMatrixExecutionRow | undefined) ?? null;
}

export function listExecutionsForMatrix(matrixRunId: string): BrowserMatrixExecutionRow[] {
  return getDb()
    .prepare("SELECT * FROM browser_matrix_executions WHERE matrix_run_id = ? ORDER BY created_at ASC")
    .all(matrixRunId) as unknown as BrowserMatrixExecutionRow[];
}

export function findExecutionForRun(runId: string): BrowserMatrixExecutionRow | null {
  return (getDb().prepare("SELECT * FROM browser_matrix_executions WHERE test_run_id = ?").get(runId) as BrowserMatrixExecutionRow | undefined) ?? null;
}

export function updateMatrixRun(id: string, input: Partial<{
  status: string;
  compatibilityScore: number | null;
  coverage: number | null;
  comparisonJson: string | null;
  reportId: string | null;
  reason: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}>): void {
  const row = getMatrixRunById(id);
  if (!row) return;
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE browser_matrix_runs SET
        status = ?, compatibility_score = ?, coverage = ?, comparison_json = ?, report_id = ?,
        reason = COALESCE(?, reason), started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at), updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.status ?? row.status,
      input.compatibilityScore !== undefined ? input.compatibilityScore : row.compatibility_score,
      input.coverage !== undefined ? input.coverage : row.coverage,
      input.comparisonJson !== undefined ? input.comparisonJson : row.comparison_json,
      input.reportId !== undefined ? input.reportId : row.report_id,
      input.reason ?? null,
      input.startedAt ?? null,
      input.finishedAt ?? null,
      now,
      id,
    );
}

export function updateMatrixExecution(id: string, input: Partial<{
  status: string;
  outcome: string | null;
  errorCode: string | null;
  reason: string | null;
  score: number | null;
  passed: number;
  failed: number;
  skipped: number;
  browserVersion: string | null;
  evidenceJson: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}>): void {
  const row = getExecutionById(id);
  if (!row) return;
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE browser_matrix_executions SET
        status = ?, outcome = ?, error_code = ?, reason = ?, score = ?, passed = ?, failed = ?, skipped = ?,
        browser_version = COALESCE(?, browser_version), evidence_json = ?, started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at), updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.status ?? row.status,
      input.outcome !== undefined ? input.outcome : row.outcome,
      input.errorCode !== undefined ? input.errorCode : row.error_code,
      input.reason !== undefined ? input.reason : row.reason,
      input.score !== undefined ? input.score : row.score,
      input.passed ?? row.passed,
      input.failed ?? row.failed,
      input.skipped ?? row.skipped,
      input.browserVersion ?? null,
      input.evidenceJson !== undefined ? input.evidenceJson : row.evidence_json,
      input.startedAt ?? null,
      input.finishedAt ?? null,
      now,
      id,
    );
}

export function listMatrixRuns(
  userId: string,
  input: { page: number; limit: number; browser?: string; status?: string },
): { items: Array<BrowserMatrixRunRow & { extensionName: string | null }>; total: number } {
  const db = getDb();
  const where: string[] = ["m.user_id = ?"];
  const params: Array<string | number> = [userId];
  if (input.browser) {
    where.push("EXISTS (SELECT 1 FROM browser_matrix_executions e WHERE e.matrix_run_id = m.id AND e.browser_id = ?)");
    params.push(input.browser);
  }
  if (input.status) {
    where.push("m.status = ?");
    params.push(input.status);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (
    db.prepare(`SELECT COUNT(*) AS total FROM browser_matrix_runs m ${whereSql}`).get(...params) as { total: number }
  ).total;
  const items = db
    .prepare(
      `SELECT m.*, e.name AS extensionName
       FROM browser_matrix_runs m
       LEFT JOIN extensions e ON e.id = m.extension_id
       ${whereSql}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, input.limit, (input.page - 1) * input.limit) as unknown as Array<BrowserMatrixRunRow & { extensionName: string | null }>;
  return { items, total };
}

export function listCompletedMatrixRunsForExtension(extensionId: string, limit = 10): BrowserMatrixRunRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM browser_matrix_runs WHERE extension_id = ? AND status IN ('completed','partial')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(extensionId, limit) as unknown as BrowserMatrixRunRow[];
}

/** Matrix runs still active past their deadline (worker sweep safety net). */
export function listStaleActiveMatrixRuns(olderThan: number): BrowserMatrixRunRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM browser_matrix_runs WHERE status IN ('queued','running') AND updated_at < ?`,
    )
    .all(olderThan) as unknown as BrowserMatrixRunRow[];
}

export function deleteMatrixRunsBefore(before: number): number {
  return Number(
    getDb()
      .prepare(
        `DELETE FROM browser_matrix_runs WHERE created_at < ? AND status NOT IN ('queued','running')`,
      )
      .run(before).changes,
  );
}
