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

export function createTestRun(input: {
  userId: string;
  extensionId: string | null;
  status: string;
  runId?: string;
  createdAt?: number;
}): TestRunRow {
  const db = getDb();
  const now = input.createdAt ?? Date.now();
  const id = input.runId ?? generateDbId("run");
  db.prepare(
    `INSERT INTO test_runs
      (id, user_id, extension_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, input.extensionId, input.status, now, now);
  return getTestRunById(id)!;
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
}): void {
  const db = getDb();
  db.prepare(
    `UPDATE test_runs SET
       status = ?, score = ?, total = ?, passed = ?, failed = ?, warnings = ?,
       skipped = ?, timeout = ?, error_count = ?, completed_at = ?,
       result_json = ?, diagnostics_json = ?, events_json = ?, updated_at = ?
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
      where.push("r.status IN ('idle','preparing','starting','running','stopping')");
      break;
    case "cancelled":
      where.push("r.status = 'destroyed'");
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
