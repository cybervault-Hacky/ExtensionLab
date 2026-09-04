import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { ShareRow } from "../schema/types";

export function createShare(input: {
  reportId: string;
  token: string;
  expiresAt: number | null;
}): ShareRow {
  const db = getDb();
  db.prepare(
    `INSERT INTO shares (id, report_id, token, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(generateDbId("sh"), input.reportId, input.token, input.expiresAt, Date.now());
  return getShareByToken(input.token)!;
}

export function getShareByToken(token: string): ShareRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM shares WHERE token = ?").get(token) as ShareRow | undefined) ??
    null
  );
}

export function getLiveShareByToken(token: string): ShareRow | null {
  const db = getDb();
  const now = Date.now();
  return (
    (db
      .prepare(
        "SELECT * FROM shares WHERE token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(token, now) as ShareRow | undefined) ?? null
  );
}

export function getActiveShareForReport(reportId: string): ShareRow | null {
  const db = getDb();
  const now = Date.now();
  return (
    (db
      .prepare(
        "SELECT * FROM shares WHERE report_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1",
      )
      .get(reportId, now) as ShareRow | undefined) ?? null
  );
}

export function revokeShare(id: string): void {
  const db = getDb();
  db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
}

export function revokeAllSharesForReport(reportId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE shares SET revoked_at = ? WHERE report_id = ? AND revoked_at IS NULL",
  ).run(Date.now(), reportId);
}

export function revokeAllSharesForUser(userId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE shares SET revoked_at = ? WHERE revoked_at IS NULL AND report_id IN
      (SELECT id FROM reports WHERE user_id = ?)`,
  ).run(Date.now(), userId);
}

export function deleteExpiredShares(): void {
  const db = getDb();
  db.prepare("DELETE FROM shares WHERE expires_at <= ?").run(Date.now());
}
