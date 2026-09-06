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
  | "share_revoked"
  | "package_delete"
  | "test_run_cancel"
  // Phase 7 billing (details never contain payment data or secrets).
  | "checkout_started"
  | "subscription_created"
  | "subscription_activated"
  | "subscription_upgraded"
  | "subscription_downgraded"
  | "subscription_cancelled"
  | "subscription_reactivated"
  | "subscription_expired"
  | "payment_succeeded"
  | "payment_failed"
  | "billing_state_changed"
  // Phase 10 internal admin (jobs/queue only; never secrets or job payloads).
  | "admin_job_retry"
  | "admin_job_cancel"
  // Phase 13 internal admin (worker lifecycle + reconciliation).
  | "admin_worker_state"
  | "admin_reconcile";

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
