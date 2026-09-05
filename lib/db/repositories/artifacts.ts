import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { ArtifactRow } from "../schema/types";

export const ARTIFACT_TYPES = ["screenshot", "runtime-log", "network-summary"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ArtifactSummary {
  id: string;
  testRunId: string;
  type: ArtifactType;
  size: number;
  sha256: string;
  contentType: string;
  label: string | null;
  createdAt: number;
  expiresAt: number;
}

/** Projection safe for the owner: no storage key, no path. */
export function toArtifactSummary(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id,
    testRunId: row.test_run_id,
    type: row.type as ArtifactType,
    size: row.size,
    sha256: row.sha256,
    contentType: row.content_type,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Projection for public reports: counts only, never ids or hashes. */
export function toPublicArtifactSummary(rows: ArtifactRow[]): { screenshots: number; runtimeLogs: number; networkSummaries: number } {
  return {
    screenshots: rows.filter((row) => row.type === "screenshot").length,
    runtimeLogs: rows.filter((row) => row.type === "runtime-log").length,
    networkSummaries: rows.filter((row) => row.type === "network-summary").length,
  };
}

export function createArtifactRecord(input: {
  testRunId: string;
  userId: string;
  type: ArtifactType;
  storageKey: string;
  size: number;
  sha256: string;
  contentType: string;
  label?: string | null;
  expiresAt: number;
}): ArtifactRow {
  const db = getDb();
  const id = generateDbId("art");
  db.prepare(
    `INSERT INTO artifacts (id, test_run_id, user_id, type, storage_key, size, sha256, content_type, label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.testRunId,
    input.userId,
    input.type,
    input.storageKey,
    input.size,
    input.sha256,
    input.contentType,
    input.label ?? null,
    Date.now(),
    input.expiresAt,
  );
  return getArtifactById(id)!;
}

export function getArtifactById(id: string): ArtifactRow | null {
  return (getDb().prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined) ?? null;
}

export function getOwnedArtifact(userId: string, id: string): ArtifactRow | null {
  return (
    (getDb().prepare("SELECT * FROM artifacts WHERE id = ? AND user_id = ?").get(id, userId) as ArtifactRow | undefined) ??
    null
  );
}

export function listArtifactsForRun(testRunId: string): ArtifactRow[] {
  return getDb()
    .prepare("SELECT * FROM artifacts WHERE test_run_id = ? ORDER BY created_at ASC")
    .all(testRunId) as unknown as ArtifactRow[];
}

export function listExpiredArtifacts(now = Date.now(), limit = 200): ArtifactRow[] {
  return getDb()
    .prepare("SELECT * FROM artifacts WHERE expires_at < ? ORDER BY expires_at ASC LIMIT ?")
    .all(now, limit) as unknown as ArtifactRow[];
}

export function deleteArtifactRecord(id: string): void {
  getDb().prepare("DELETE FROM artifacts WHERE id = ?").run(id);
}

export function listAllArtifactKeys(): Array<{ id: string; storage_key: string }> {
  return getDb().prepare("SELECT id, storage_key FROM artifacts").all() as unknown as Array<{ id: string; storage_key: string }>;
}

export function countArtifactsForRun(testRunId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS total FROM artifacts WHERE test_run_id = ?").get(testRunId) as { total: number })
    .total;
}
