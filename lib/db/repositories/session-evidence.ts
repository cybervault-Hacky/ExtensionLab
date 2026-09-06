import "server-only";
import { getDb } from "@/lib/db/client";
import { generateDbId } from "@/lib/db/ids";
import type { SessionEvidenceRow } from "@/lib/db/schema/types";

/**
 * Phase 12 session-evidence repository.
 *
 * Evidence rows reference runtime records; the summary and metadata fields
 * are bounded and redacted by the service BEFORE they reach this layer. The
 * repository performs no policy decisions.
 */

export function insertSessionEvidence(input: {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  kind: SessionEvidenceRow["kind"];
  refId: string | null;
  label: string | null;
  summary: string;
  metadataJson: string;
  packageId: string | null;
  packageVersion: string | null;
  packageSha256: string;
  browser: string;
  browserVersion: string | null;
}): SessionEvidenceRow {
  const db = getDb();
  const now = Date.now();
  const id = generateDbId("ev");
  db.prepare(
    `INSERT INTO session_evidence
      (id, session_id, user_id, organization_id, kind, ref_id, label, summary, metadata_json,
       package_id, package_version, package_sha256, browser, browser_version, report_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    input.sessionId,
    input.userId,
    input.organizationId,
    input.kind,
    input.refId,
    input.label,
    input.summary,
    input.metadataJson,
    input.packageId,
    input.packageVersion,
    input.packageSha256,
    input.browser,
    input.browserVersion,
    now,
  );
  return getSessionEvidenceById(id)!;
}

export function getSessionEvidenceById(id: string): SessionEvidenceRow | null {
  return (
    (getDb().prepare("SELECT * FROM session_evidence WHERE id = ?").get(id) as SessionEvidenceRow | undefined) ?? null
  );
}

export function getOwnedSessionEvidence(userId: string, id: string): SessionEvidenceRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM session_evidence WHERE id = ? AND user_id = ?")
      .get(id, userId) as SessionEvidenceRow | undefined) ?? null
  );
}

export function listSessionEvidence(sessionId: string, limit = 100): SessionEvidenceRow[] {
  return getDb()
    .prepare("SELECT * FROM session_evidence WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(sessionId, limit) as unknown as SessionEvidenceRow[];
}

export function countSessionEvidence(sessionId: string): number {
  return Number(
    (getDb().prepare("SELECT COUNT(*) AS n FROM session_evidence WHERE session_id = ?").get(sessionId) as { n: number }).n,
  );
}

export function attachEvidenceToReport(id: string, reportId: string): boolean {
  return (
    getDb()
      .prepare("UPDATE session_evidence SET report_id = ? WHERE id = ? AND report_id IS NULL")
      .run(reportId, id).changes > 0
  );
}

export function deleteSessionEvidenceRow(id: string, userId: string): boolean {
  // Evidence already attached to a report is part of that report's record and
  // is not deletable from the session view.
  return (
    getDb()
      .prepare("DELETE FROM session_evidence WHERE id = ? AND user_id = ? AND report_id IS NULL")
      .run(id, userId).changes > 0
  );
}
