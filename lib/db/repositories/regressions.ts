import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { RegressionComparisonRow } from "../schema/types";

/** Phase 9 stored regression comparisons (previous vs current package). */

export function createRegressionComparisonRow(input: {
  userId: string;
  extensionId: string | null;
  packageVersionIdPrev: string | null;
  packageVersionIdCurrent: string | null;
  testSuiteId: string | null;
  browsers: string[];
  previousMatrixRunId: string | null;
  currentMatrixRunId: string | null;
  previousRunId: string | null;
  currentRunId: string | null;
  resultJson: string;
  regressionCount: number;
  improvementCount: number;
}): RegressionComparisonRow {
  const db = getDb();
  const id = generateDbId("regr");
  db.prepare(
    `INSERT INTO regression_comparisons
      (id, user_id, extension_id, package_version_id_prev, package_version_id_current, test_suite_id,
       browsers_json, previous_matrix_run_id, current_matrix_run_id, previous_run_id, current_run_id,
       result_json, regression_count, improvement_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.extensionId,
    input.packageVersionIdPrev,
    input.packageVersionIdCurrent,
    input.testSuiteId,
    JSON.stringify(input.browsers),
    input.previousMatrixRunId,
    input.currentMatrixRunId,
    input.previousRunId,
    input.currentRunId,
    input.resultJson,
    input.regressionCount,
    input.improvementCount,
    Date.now(),
  );
  return (getDb().prepare("SELECT * FROM regression_comparisons WHERE id = ?").get(id) as unknown as RegressionComparisonRow)!;
}

export function getRegressionComparisonById(id: string): RegressionComparisonRow | null {
  return (getDb().prepare("SELECT * FROM regression_comparisons WHERE id = ?").get(id) as RegressionComparisonRow | undefined) ?? null;
}

export function getOwnedRegressionComparison(userId: string, id: string): RegressionComparisonRow | null {
  const row = getRegressionComparisonById(id);
  return row && row.user_id === userId ? row : null;
}

export function listRegressionComparisons(userId: string, limit = 20): RegressionComparisonRow[] {
  return getDb()
    .prepare("SELECT * FROM regression_comparisons WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as unknown as RegressionComparisonRow[];
}

export function deleteRegressionComparisonsBefore(before: number): number {
  return Number(getDb().prepare("DELETE FROM regression_comparisons WHERE created_at < ?").run(before).changes);
}
