import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { ReportRow } from "../schema/types";

export interface ReportWithExtension extends ReportRow {
  extensionName: string | null;
  extensionVersion: string | null;
}

export type ReportSort = "newest" | "oldest" | "score_desc" | "score_asc" | "name";

const sortMap: Record<ReportSort, string> = {
  newest: "r.created_at DESC",
  oldest: "r.created_at ASC",
  score_desc: "r.overall_score DESC, r.created_at DESC",
  score_asc: "r.overall_score ASC, r.created_at DESC",
  name: "e.name COLLATE NOCASE ASC, r.created_at DESC",
};

export function createReport(input: {
  userId: string;
  extensionId: string | null;
  analysisSnapshotId: string | null;
  testRunId: string | null;
  title: string;
  summary: string | null;
  healthScore: number | null;
  runtimeScore: number | null;
  overallScore: number | null;
  reportJson: string;
  id?: string;
  createdAt?: number;
  organizationId?: string | null;
}): ReportRow {
  const db = getDb();
  const now = input.createdAt ?? Date.now();
  const id = input.id ?? generateDbId("rep");
  db.prepare(
    `INSERT INTO reports
      (id, user_id, extension_id, analysis_snapshot_id, test_run_id, title, summary,
       health_score, runtime_score, overall_score, report_json, created_at, updated_at, organization_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.extensionId,
    input.analysisSnapshotId,
    input.testRunId,
    input.title,
    input.summary,
    input.healthScore,
    input.runtimeScore,
    input.overallScore,
    input.reportJson,
    now,
    now,
    input.organizationId ?? null,
  );
  return getReportById(id)!;
}

/** Phase 10: organization-scoped report lookup (API-key paths). */
export function getOrgReport(organizationId: string, id: string): ReportRow | null {
  const row = getDb().prepare("SELECT * FROM reports WHERE id = ? AND organization_id = ?").get(id, organizationId);
  return (row as unknown as ReportRow | undefined) ?? null;
}

export function getReportById(id: string): ReportRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportRow | undefined) ??
    null
  );
}

export function getOwnedReport(userId: string, id: string): ReportWithExtension | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT r.*, e.name AS extensionName, e.version AS extensionVersion
       FROM reports r
       LEFT JOIN extensions e ON e.id = r.extension_id
       WHERE r.id = ? AND r.user_id = ?`,
    )
    .get(id, userId) as
    | (ReportRow & { extensionName: string | null; extensionVersion: string | null })
    | undefined;
  return row ?? null;
}

export function listReports(
  userId: string,
  input: { page: number; limit: number; search?: string; sort?: ReportSort },
): { items: ReportWithExtension[]; total: number } {
  const db = getDb();
  const where: string[] = ["r.user_id = ?"];
  const params: string[] = [userId];
  if (input.search?.trim()) {
    const term = `%${input.search.trim()}%`;
    where.push("(r.title LIKE ? OR e.name LIKE ?)");
    params.push(term, term);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM reports r LEFT JOIN extensions e ON e.id = r.extension_id ${whereSql}`,
      )
      .get(...params) as { total: number }
  ).total;
  const items = db
    .prepare(
      `SELECT r.*, e.name AS extensionName, e.version AS extensionVersion
       FROM reports r
       LEFT JOIN extensions e ON e.id = r.extension_id
       ${whereSql}
       ORDER BY ${sortMap[input.sort ?? "newest"]}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, input.limit, (input.page - 1) * input.limit) as unknown as ReportWithExtension[];
  return { items, total };
}

export function countReports(userId: string): number {
  const db = getDb();
  return (
    db.prepare("SELECT COUNT(*) AS total FROM reports WHERE user_id = ?").get(userId) as {
      total: number;
    }
  ).total;
}

export function getReportsForComparison(
  userId: string,
  ids: [string, string],
): ReportWithExtension[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT r.*, e.name AS extensionName, e.version AS extensionVersion
       FROM reports r
       LEFT JOIN extensions e ON e.id = r.extension_id
       WHERE r.id IN (?, ?) AND r.user_id = ?`,
    )
    .all(ids[0], ids[1], userId) as unknown as ReportWithExtension[];
}
