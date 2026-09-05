import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { TestBaselineRow } from "../schema/types";

/**
 * Phase 9 baselines. A baseline pins the exact package version, analysis
 * snapshot, test suite and browser configuration a future run is compared
 * against — never an ambiguous "latest".
 */

export function setBaseline(input: {
  userId: string;
  extensionId: string;
  packageId: string;
  snapshotId?: string | null;
  testSuiteId: string;
  browsers: string[];
  matrixRunId?: string | null;
  runId?: string | null;
  score?: number | null;
}): TestBaselineRow {
  const db = getDb();
  const now = Date.now();
  const existing = getBaselineForExtension(input.userId, input.extensionId);
  db.prepare(
    `INSERT INTO test_baselines
      (id, user_id, extension_id, package_id, snapshot_id, test_suite_id, browsers_json, matrix_run_id, run_id, score, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, extension_id) DO UPDATE SET
       package_id = excluded.package_id,
       snapshot_id = excluded.snapshot_id,
       test_suite_id = excluded.test_suite_id,
       browsers_json = excluded.browsers_json,
       matrix_run_id = excluded.matrix_run_id,
       run_id = excluded.run_id,
       score = excluded.score,
       updated_at = excluded.updated_at`,
  ).run(
    existing?.id ?? generateDbId("base"),
    input.userId,
    input.extensionId,
    input.packageId,
    input.snapshotId ?? null,
    input.testSuiteId,
    JSON.stringify(input.browsers),
    input.matrixRunId ?? null,
    input.runId ?? null,
    input.score ?? null,
    existing?.created_at ?? now,
    now,
  );
  return getBaselineForExtension(input.userId, input.extensionId)!;
}

export function getBaselineForExtension(userId: string, extensionId: string): TestBaselineRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM test_baselines WHERE user_id = ? AND extension_id = ?")
      .get(userId, extensionId) as TestBaselineRow | undefined) ?? null
  );
}

export function deleteBaseline(userId: string, extensionId: string): boolean {
  const res = getDb()
    .prepare("DELETE FROM test_baselines WHERE user_id = ? AND extension_id = ?")
    .run(userId, extensionId);
  return res.changes > 0;
}

export function deleteBaselinesBefore(before: number): number {
  return Number(getDb().prepare("DELETE FROM test_baselines WHERE created_at < ?").run(before).changes);
}
