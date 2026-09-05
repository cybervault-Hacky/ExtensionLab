import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { ExtensionRow } from "../schema/types";

export type ExtensionSort =
  | "newest"
  | "oldest"
  | "name"
  | "health_desc"
  | "health_asc";

export interface ExtensionWithSummary extends ExtensionRow {
  analysisCount: number;
  testCount: number;
  latestAnalysisId: string | null;
}

const sortMap: Record<ExtensionSort, string> = {
  newest: "e.created_at DESC",
  oldest: "e.created_at ASC",
  name: "e.name COLLATE NOCASE ASC",
  health_desc: "e.health_score DESC, e.created_at DESC",
  health_asc: "e.health_score ASC, e.created_at DESC",
};

export function createExtension(input: {
  userId: string;
  name: string;
  version: string | null;
  manifestVersion: string | null;
  sourceName: string | null;
  healthScore: number;
}): ExtensionRow {
  const db = getDb();
  const now = Date.now();
  const id = generateDbId("ext");
  db.prepare(
    `INSERT INTO extensions
      (id, user_id, name, version, manifest_version, source_name, health_score, status, last_analyzed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'analyzed', ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.name,
    input.version,
    input.manifestVersion,
    input.sourceName,
    input.healthScore,
    now,
    now,
    now,
  );
  return getExtensionById(id)!;
}

export function getExtensionById(id: string): ExtensionRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM extensions WHERE id = ?").get(id) as
      | ExtensionRow
      | undefined) ?? null
  );
}

export function getOwnedExtension(userId: string, id: string): ExtensionRow | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM extensions WHERE id = ? AND user_id = ?")
      .get(id, userId) as ExtensionRow | undefined) ?? null
  );
}

export function listExtensions(
  userId: string,
  input: {
    page: number;
    limit: number;
    search?: string;
    sort?: ExtensionSort;
  },
): { items: ExtensionWithSummary[]; total: number } {
  const db = getDb();
  const offset = (input.page - 1) * input.limit;
  const where: string[] = ["e.user_id = ?"];
  const params: string[] = [userId];
  if (input.search?.trim()) {
    where.push("(e.name LIKE ? OR e.version LIKE ? OR e.status LIKE ?)");
    const term = `%${input.search.trim()}%`;
    params.push(term, term, term);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const order = sortMap[input.sort ?? "newest"];

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM extensions e ${whereSql}`)
    .get(...params) as { total: number };
  const rows = db
    .prepare(
      `SELECT e.*,
         (SELECT COUNT(*) FROM analysis_snapshots s WHERE s.extension_id = e.id) AS analysisCount,
         (SELECT COUNT(*) FROM test_runs r WHERE r.extension_id = e.id) AS testCount,
         (SELECT s.id FROM analysis_snapshots s WHERE s.extension_id = e.id ORDER BY s.created_at DESC LIMIT 1) AS latestAnalysisId
       FROM extensions e
       ${whereSql}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, input.limit, offset) as unknown as Array<
    ExtensionRow & { analysisCount: number; testCount: number; latestAnalysisId: string | null }
  >;

  return { items: rows, total: totalRow.total };
}

export function updateExtensionFromAnalysis(input: {
  id: string;
  name: string;
  version: string | null;
  manifestVersion: string | null;
  healthScore: number;
}): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE extensions SET name = ?, version = ?, manifest_version = ?, health_score = ?, last_analyzed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.name,
    input.version,
    input.manifestVersion,
    input.healthScore,
    now,
    now,
    input.id,
  );
}

export function markExtensionTested(input: {
  id: string;
  status: string;
  score?: number;
}): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE extensions SET last_tested_at = ?, last_test_status = ?, updated_at = ? WHERE id = ?`,
  ).run(now, input.status, now, input.id);
}

export function deleteExtension(userId: string, id: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM extensions WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return result.changes > 0;
}

export function countExtensions(userId: string): number {
  const db = getDb();
  return (
    db.prepare("SELECT COUNT(*) AS total FROM extensions WHERE user_id = ?").get(userId) as {
      total: number;
    }
  ).total;
}
