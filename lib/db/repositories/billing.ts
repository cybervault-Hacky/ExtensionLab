import { getDb, transaction } from "../client";
import { generateDbId } from "../ids";
import type { BillingCustomerRow, BillingEventRow, BillingPaymentRow, CheckoutSessionRow, SubscriptionRow } from "../schema/types";
import type { BillingEventType, PlanId, SubscriptionStatus } from "@/lib/billing/types";

/*
 * Billing persistence. Only provider identifiers and normalized subscription
 * state are stored — never payment instruments. Writes happen through the
 * webhook processor / billing service, never from user-facing routes directly.
 */

// ---------------------------------------------------------------------------
// Customers

export function getBillingCustomer(userId: string, provider: string): BillingCustomerRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM billing_customers WHERE user_id = ? AND provider = ?")
      .get(userId, provider) as BillingCustomerRow | undefined) ?? null
  );
}

export function findUserIdByProviderCustomer(provider: string, providerCustomerId: string): string | null {
  const row = getDb()
    .prepare("SELECT user_id FROM billing_customers WHERE provider = ? AND provider_customer_id = ?")
    .get(provider, providerCustomerId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function upsertBillingCustomer(input: { userId: string; provider: string; providerCustomerId: string }): BillingCustomerRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO billing_customers (user_id, provider, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET provider_customer_id = excluded.provider_customer_id, updated_at = excluded.updated_at`,
    )
    .run(input.userId, input.provider, input.providerCustomerId, now, now);
  return getBillingCustomer(input.userId, input.provider)!;
}

// ---------------------------------------------------------------------------
// Subscriptions

export interface UpsertSubscriptionInput {
  userId: string;
  provider: string;
  providerCustomerId: string;
  providerSubscriptionId: string;
  providerPriceId: string | null;
  planId: PlanId;
  status: SubscriptionStatus;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: number | null;
  canceledAt: number | null;
  trialEnd: number | null;
  endedAt: number | null;
  /** Provider event timestamp; an older event never overwrites a newer state. */
  eventAt: number;
}

export function getSubscriptionByProviderId(provider: string, providerSubscriptionId: string): SubscriptionRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM subscriptions WHERE provider = ? AND provider_subscription_id = ?")
      .get(provider, providerSubscriptionId) as SubscriptionRow | undefined) ?? null
  );
}

export function getSubscriptionById(id: string): SubscriptionRow | null {
  return (getDb().prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as SubscriptionRow | undefined) ?? null;
}

/**
 * Inserts or updates the local copy of a provider subscription. Returns the
 * row and whether anything changed; out-of-order (older) events are ignored so
 * webhook retries and reordering can never roll state backwards.
 */
export function upsertSubscription(input: UpsertSubscriptionInput): { row: SubscriptionRow; changed: boolean; previous: SubscriptionRow | null } {
  const db = getDb();
  return transaction(db, () => {
    const previous = getSubscriptionByProviderId(input.provider, input.providerSubscriptionId);
    const now = Date.now();
    // Provider event timestamps have second precision while local actions use
    // milliseconds; compare at second granularity so an event emitted in the
    // same second as a local action is not mistaken for a stale one.
    if (previous && Math.floor(input.eventAt / 1000) < Math.floor(previous.last_event_at / 1000)) {
      return { row: previous, changed: false, previous };
    }
    if (!previous) {
      const id = generateDbId("sub");
      db.prepare(
        `INSERT INTO subscriptions (
           id, user_id, provider, provider_customer_id, provider_subscription_id, provider_price_id, plan_id, status,
           current_period_start, current_period_end, cancel_at_period_end, cancel_at, canceled_at, trial_end, ended_at,
           last_event_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.userId,
        input.provider,
        input.providerCustomerId,
        input.providerSubscriptionId,
        input.providerPriceId,
        input.planId,
        input.status,
        input.currentPeriodStart,
        input.currentPeriodEnd,
        input.cancelAtPeriodEnd ? 1 : 0,
        input.cancelAt,
        input.canceledAt,
        input.trialEnd,
        input.endedAt,
        input.eventAt,
        now,
        now,
      );
      return { row: getSubscriptionById(id)!, changed: true, previous: null };
    }
    db.prepare(
      `UPDATE subscriptions SET
         provider_customer_id = ?, provider_price_id = ?, plan_id = ?, status = ?,
         current_period_start = ?, current_period_end = ?, cancel_at_period_end = ?, cancel_at = ?, canceled_at = ?,
         trial_end = ?, ended_at = ?, last_event_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.providerCustomerId,
      input.providerPriceId,
      input.planId,
      input.status,
      input.currentPeriodStart,
      input.currentPeriodEnd,
      input.cancelAtPeriodEnd ? 1 : 0,
      input.cancelAt,
      input.canceledAt,
      input.trialEnd,
      input.endedAt,
      input.eventAt,
      now,
      previous.id,
    );
    const row = getSubscriptionById(previous.id)!;
    const changed =
      row.status !== previous.status ||
      row.plan_id !== previous.plan_id ||
      row.cancel_at_period_end !== previous.cancel_at_period_end ||
      row.current_period_end !== previous.current_period_end ||
      row.current_period_start !== previous.current_period_start ||
      row.ended_at !== previous.ended_at;
    return { row, changed, previous };
  });
}

const RELEVANT_STATUSES: readonly SubscriptionStatus[] = ["trialing", "active", "past_due", "paused", "incomplete", "unpaid"];

/**
 * The subscription that currently governs the user's entitlements: the most
 * recently updated one in a non-terminal state, else the most recent terminal
 * one (so the UI can explain "cancelled"/"expired"), else null.
 */
export function getCurrentSubscription(userId: string): SubscriptionRow | null {
  const db = getDb();
  const placeholders = RELEVANT_STATUSES.map(() => "?").join(",");
  const live = db
    .prepare(
      `SELECT * FROM subscriptions WHERE user_id = ? AND status IN (${placeholders})
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(userId, ...RELEVANT_STATUSES) as SubscriptionRow | undefined;
  if (live) return live;
  return (
    (db
      .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(userId) as SubscriptionRow | undefined) ?? null
  );
}

export function listSubscriptionsForUser(userId: string): SubscriptionRow[] {
  return getDb()
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as unknown as SubscriptionRow[];
}

/** Subscriptions still open on the provider side (used by account deletion). */
export function listOpenSubscriptionsForUser(userId: string): SubscriptionRow[] {
  const placeholders = RELEVANT_STATUSES.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`)
    .all(userId, ...RELEVANT_STATUSES) as unknown as SubscriptionRow[];
}

// ---------------------------------------------------------------------------
// Billing events (webhook idempotency ledger)

export type BillingEventResult = "processing" | "processed" | "ignored" | "failed";

/**
 * Claims a provider event for processing. Returns `null` when the event was
 * already processed (duplicate delivery). A previously *failed* claim is
 * re-opened so the provider's retry gets another chance.
 */
export function claimBillingEvent(input: {
  provider: string;
  providerEventId: string;
  eventType: BillingEventType;
  providerEventType: string;
}): BillingEventRow | null {
  const db = getDb();
  return transaction(db, () => {
    const existing = db
      .prepare("SELECT * FROM billing_events WHERE provider = ? AND provider_event_id = ?")
      .get(input.provider, input.providerEventId) as BillingEventRow | undefined;
    const now = Date.now();
    if (existing) {
      if (existing.result === "processed" || existing.result === "ignored") return null;
      db.prepare("UPDATE billing_events SET result = 'processing', processed_at = NULL WHERE id = ?").run(existing.id);
      return { ...existing, result: "processing", processed_at: null };
    }
    const id = generateDbId("bev");
    db.prepare(
      `INSERT INTO billing_events (id, provider, provider_event_id, event_type, provider_event_type, result, created_at)
       VALUES (?, ?, ?, ?, ?, 'processing', ?)`,
    ).run(id, input.provider, input.providerEventId, input.eventType, input.providerEventType, now);
    return db.prepare("SELECT * FROM billing_events WHERE id = ?").get(id) as unknown as BillingEventRow;
  });
}

export function finishBillingEvent(id: string, input: { result: BillingEventResult; userId?: string | null; subscriptionId?: string | null }): void {
  getDb()
    .prepare(
      `UPDATE billing_events SET result = ?, processed_at = ?, user_id = COALESCE(?, user_id), subscription_id = COALESCE(?, subscription_id)
       WHERE id = ?`,
    )
    .run(input.result, Date.now(), input.userId ?? null, input.subscriptionId ?? null, id);
}

export function getBillingEvent(provider: string, providerEventId: string): BillingEventRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM billing_events WHERE provider = ? AND provider_event_id = ?")
      .get(provider, providerEventId) as BillingEventRow | undefined) ?? null
  );
}

export function listBillingEventsForUser(userId: string, limit = 50): BillingEventRow[] {
  return getDb()
    .prepare("SELECT * FROM billing_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as unknown as BillingEventRow[];
}

export function deleteOldBillingEvents(before: number): number {
  return Number(
    getDb().prepare("DELETE FROM billing_events WHERE created_at < ? AND result IN ('processed','ignored')").run(before).changes,
  );
}

// ---------------------------------------------------------------------------
// Checkout sessions

export function createCheckoutRecord(input: { userId: string; provider: string; providerSessionId: string; planId: PlanId }): CheckoutSessionRow {
  const now = Date.now();
  const id = generateDbId("chk");
  getDb()
    .prepare(
      `INSERT INTO checkout_sessions (id, user_id, provider, provider_session_id, plan_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
       ON CONFLICT(provider, provider_session_id) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .run(id, input.userId, input.provider, input.providerSessionId, input.planId, now, now);
  return getDb()
    .prepare("SELECT * FROM checkout_sessions WHERE provider = ? AND provider_session_id = ?")
    .get(input.provider, input.providerSessionId) as unknown as CheckoutSessionRow;
}

export function getOwnedCheckoutRecord(userId: string, provider: string, providerSessionId: string): CheckoutSessionRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM checkout_sessions WHERE user_id = ? AND provider = ? AND provider_session_id = ?")
      .get(userId, provider, providerSessionId) as CheckoutSessionRow | undefined) ?? null
  );
}

export function getCheckoutRecordByProviderSession(provider: string, providerSessionId: string): CheckoutSessionRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM checkout_sessions WHERE provider = ? AND provider_session_id = ?")
      .get(provider, providerSessionId) as CheckoutSessionRow | undefined) ?? null
  );
}

export function updateCheckoutStatus(provider: string, providerSessionId: string, status: "open" | "complete" | "expired"): void {
  getDb()
    .prepare("UPDATE checkout_sessions SET status = ?, updated_at = ? WHERE provider = ? AND provider_session_id = ?")
    .run(status, Date.now(), provider, providerSessionId);
}

/** Most recent open checkout for a plan, so repeated clicks reuse one session. */
export function findRecentOpenCheckout(userId: string, provider: string, planId: PlanId, notBefore: number): CheckoutSessionRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM checkout_sessions WHERE user_id = ? AND provider = ? AND plan_id = ? AND status = 'open' AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, provider, planId, notBefore) as CheckoutSessionRow | undefined) ?? null
  );
}

export function expireStaleCheckouts(before: number): number {
  return Number(
    getDb()
      .prepare("UPDATE checkout_sessions SET status = 'expired', updated_at = ? WHERE status = 'open' AND created_at < ?")
      .run(Date.now(), before).changes,
  );
}

export function deleteOldCheckouts(before: number): number {
  return Number(getDb().prepare("DELETE FROM checkout_sessions WHERE created_at < ? AND status <> 'open'").run(before).changes);
}

// ---------------------------------------------------------------------------
// Phase 14: payments ledger (idempotent, verified events only)
// ---------------------------------------------------------------------------

/**
 * Records a payment exactly once per (provider, provider_payment_id).
 * Duplicate webhook deliveries and concurrent confirmations converge on a
 * single row; `created` tells the caller whether this was the first write.
 */
export function recordPaymentIfNew(input: {
  userId: string;
  provider: string;
  providerPaymentId: string;
  providerInvoiceId?: string | null;
  providerSubscriptionId?: string | null;
  planId: string;
  amount: number;
  currency: string;
  status: "paid" | "failed";
  createdAt?: number;
}): { created: boolean } {
  const db = getDb();
  const existing = db
    .prepare("SELECT 1 FROM billing_payments WHERE provider = ? AND provider_payment_id = ?")
    .get(input.provider, input.providerPaymentId);
  if (existing) return { created: false };
  db.prepare(
    `INSERT INTO billing_payments (
       id, user_id, provider, provider_payment_id, provider_invoice_id, provider_subscription_id,
       plan_id, amount, currency, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    generateDbId("pay"),
    input.userId,
    input.provider,
    input.providerPaymentId,
    input.providerInvoiceId ?? null,
    input.providerSubscriptionId ?? null,
    input.planId,
    Math.round(input.amount),
    input.currency.toLowerCase(),
    input.status,
    input.createdAt ?? Date.now(),
  );
  return { created: true };
}

export function listPaymentsForUser(userId: string, limit = 20): BillingPaymentRow[] {
  return getDb()
    .prepare("SELECT * FROM billing_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, Math.min(Math.max(limit, 1), 100)) as unknown as BillingPaymentRow[];
}

export function deleteOldBillingPayments(before: number): number {
  return Number(getDb().prepare("DELETE FROM billing_payments WHERE created_at < ?").run(before).changes);
}
