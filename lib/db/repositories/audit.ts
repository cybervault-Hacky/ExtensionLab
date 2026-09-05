import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { AuditEventRow } from "../schema/types";

export type AuditEventType =
  | "login"
  | "logout"
  | "signup"
  | "password_change"
  | "password_reset"
  | "account_delete"
  | "share_created"
  | "share_revoked";

export function recordAuditEvent(input: {
  userId: string | null;
  type: AuditEventType;
  detail?: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_events (id, user_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(generateDbId("aud"), input.userId, input.type, input.detail ?? null, Date.now());
}

export function listAuditEvents(userId: string, limit = 20): AuditEventRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(userId, limit) as unknown as AuditEventRow[];
}
