import { getDb, transaction } from "../client";
import { generateDbId } from "../ids";
import type { QuotaReservationRow } from "../schema/types";
import { recordUsage, type UsageKind } from "./usage";
import { canAnalyze, canRunTests, canUseAI, getQuotaUsage, type QuotaDenial } from "@/lib/billing/entitlements";

/**
 * Atomic quota reservations.
 *
 * A reservation is created inside the same transaction that accepts a job, so
 * the monthly limit can never be exceeded by concurrent requests. When the
 * sandbox actually starts the reservation is *consumed* (a usage event is
 * recorded); when the run never reaches that point (sandbox unavailable,
 * cancelled while queued, infrastructure error) the reservation is *released*
 * and the user's quota is not charged. This preserves the Phase 5 policy that
 * failed sandbox starts do not consume quota.
 */

export interface QuotaSnapshot {
  used: number;
  reserved: number;
  limit: number;
  remaining: number;
  /** When the current usage period ends and the counters start over. */
  resetAt: number;
}

/**
 * Open reservations in the user's *current usage period* (Phase 7: the
 * subscription's billing period for paid plans, the calendar month otherwise).
 */
export function countOpenReservations(userId: string, kind: UsageKind): number {
  return getQuotaUsage(userId, kind).reserved;
}

/** Plan- and period-aware usage snapshot (delegates to the entitlement service). */
export function getQuotaSnapshot(userId: string, kind: UsageKind): QuotaSnapshot {
  const usage = getQuotaUsage(userId, kind);
  return { used: usage.used, reserved: usage.reserved, limit: usage.limit, remaining: usage.remaining, resetAt: usage.resetAt };
}

export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";
  readonly denial: QuotaDenial | null;
  constructor(readonly kind: UsageKind, readonly snapshot: QuotaSnapshot, denial: QuotaDenial | null = null) {
    super("Quota exceeded.");
    this.name = "QuotaExceededError";
    this.denial = denial;
  }
}

/**
 * Reserves one unit of quota or throws `QuotaExceededError`. Must be called
 * inside the transaction that creates the job so the check and the insert are
 * atomic (BEGIN IMMEDIATE serializes writers).
 */
export function reserveQuota(input: {
  userId: string;
  kind: UsageKind;
  resourceId?: string | null;
  jobId?: string | null;
}): QuotaReservationRow {
  const db = getDb();
  return transaction(db, () => {
    // The entitlement check runs inside the writer transaction (BEGIN IMMEDIATE),
    // so two simultaneous requests for the last unit serialize here and only
    // one of them can insert a reservation.
    const verdict =
      input.kind === "analysis" ? canAnalyze(input.userId) : input.kind === "ai_request" ? canUseAI(input.userId) : canRunTests(input.userId);
    if (!verdict.allowed) {
      const snapshot = getQuotaSnapshot(input.userId, input.kind);
      throw new QuotaExceededError(input.kind, snapshot, verdict.reason === "quota" ? verdict.quota : null);
    }
    const id = generateDbId("qres");
    db.prepare(
      `INSERT INTO quota_reservations (id, user_id, kind, resource_id, job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.userId, input.kind, input.resourceId ?? null, input.jobId ?? null, Date.now());
    return getReservation(id)!;
  });
}

export function getReservation(id: string): QuotaReservationRow | null {
  return (
    (getDb().prepare("SELECT * FROM quota_reservations WHERE id = ?").get(id) as QuotaReservationRow | undefined) ??
    null
  );
}

export function findReservationForResource(resourceId: string): QuotaReservationRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM quota_reservations WHERE resource_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(resourceId) as QuotaReservationRow | undefined) ?? null
  );
}

/** Converts a reservation into a real usage event exactly once. */
export function consumeReservation(id: string): boolean {
  const db = getDb();
  return transaction(db, () => {
    const row = getReservation(id);
    if (!row || row.consumed_at !== null || row.released_at !== null) return false;
    db.prepare("UPDATE quota_reservations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND released_at IS NULL").run(
      Date.now(),
      id,
    );
    recordUsage(row.user_id, row.kind as UsageKind);
    return true;
  });
}

/** Releases a reservation that will never be consumed. Idempotent. */
export function releaseReservation(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE quota_reservations SET released_at = ? WHERE id = ? AND consumed_at IS NULL AND released_at IS NULL")
    .run(Date.now(), id);
  return result.changes > 0;
}

export function releaseReservationForResource(resourceId: string): boolean {
  const row = findReservationForResource(resourceId);
  return row ? releaseReservation(row.id) : false;
}

export function consumeReservationForResource(resourceId: string): boolean {
  const row = findReservationForResource(resourceId);
  return row ? consumeReservation(row.id) : false;
}

/** Releases reservations whose job reached a terminal state without consuming them. */
export function releaseDanglingReservations(olderThan: number): number {
  const result = getDb()
    .prepare(
      `UPDATE quota_reservations SET released_at = ?
       WHERE consumed_at IS NULL AND released_at IS NULL AND created_at < ?
         AND (job_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM jobs j WHERE j.id = quota_reservations.job_id AND j.status IN ('queued','running','retrying')
         ))`,
    )
    .run(Date.now(), olderThan);
  return Number(result.changes);
}

export function deleteOldReservations(before: number): number {
  return Number(
    getDb()
      .prepare("DELETE FROM quota_reservations WHERE created_at < ? AND (consumed_at IS NOT NULL OR released_at IS NOT NULL)")
      .run(before).changes,
  );
}
