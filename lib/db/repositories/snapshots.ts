import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { AnalysisSnapshotRow } from "../schema/types";

export function createSnapshot(input: {
  extensionId: string;
  healthScore: number;
  manifestVersion: string | null;
  analysisJson: string;
  packageId?: string | null;
}): AnalysisSnapshotRow {
  const db = getDb();
  const now = Date.now();
  const id = generateDbId("ana");
  db.prepare(
    `INSERT INTO analysis_snapshots (id, extension_id, health_score, manifest_version, analysis_json, created_at, package_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.extensionId,
    input.healthScore,
    input.manifestVersion,
    input.analysisJson,
    now,
    input.packageId ?? null,
  );
  return getSnapshotById(id)!;
}

export function getSnapshotById(id: string): AnalysisSnapshotRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM analysis_snapshots WHERE id = ?").get(id) as
      | AnalysisSnapshotRow
      | undefined) ?? null
  );
}

export function getOwnedSnapshot(userId: string, id: string): AnalysisSnapshotRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT s.* FROM analysis_snapshots s
         JOIN extensions e ON e.id = s.extension_id
         WHERE s.id = ? AND e.user_id = ?`,
      )
      .get(id, userId) as AnalysisSnapshotRow | undefined) ?? null
  );
}

export function getLatestSnapshot(extensionId: string): AnalysisSnapshotRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT * FROM analysis_snapshots WHERE extension_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(extensionId) as AnalysisSnapshotRow | undefined) ?? null
  );
}

export function listSnapshots(extensionId: string, limit = 20): AnalysisSnapshotRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM analysis_snapshots WHERE extension_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(extensionId, limit) as unknown as AnalysisSnapshotRow[];
}

/** Phase 11: the analysis recorded for one exact package (immutable evidence). */
export function getSnapshotByPackageId(packageId: string): AnalysisSnapshotRow | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM analysis_snapshots WHERE package_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(packageId) as AnalysisSnapshotRow | undefined) ?? null
  );
}
