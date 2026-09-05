import "server-only";
import { getConfig } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import { getCurrentSubscription } from "@/lib/db/repositories/billing";
import type { SubscriptionRow } from "@/lib/db/schema/types";
import type { UsageKind } from "@/lib/db/repositories/usage";
import { getPlan, getPlanCatalog } from "./config";
import { isPlanId, smallestPlanWithLimit } from "./plans";
import type { BillingStateKind, Plan, PlanId, QuotaUsage, UsagePeriod } from "./types";

/**
 * Central entitlement service.
 *
 *   verified provider state (subscriptions table)
 *     → effective plan
 *       → limits / features
 *         → usage inside the current billing period
 *
 * Everything user-facing that depends on a plan goes through here; routes
 * never compare plan ids themselves. The service only reads local state — it
 * never calls the payment provider, so a provider outage can never downgrade
 * anybody.
 */

const DAY = 24 * 60 * 60 * 1000;

export interface EffectivePlan {
  plan: Plan;
  /** Plan the subscription was bought for (may differ from `plan` when lapsed). */
  subscribedPlanId: PlanId | null;
  state: BillingStateKind;
  subscription: SubscriptionRow | null;
  /** True when paid entitlements are currently granted. */
  paid: boolean;
  /** When paid entitlements end if nothing changes (period end / cancel_at), else null. */
  paidUntil: number | null;
  /** Past-due grace window end, when applicable. */
  graceUntil: number | null;
}

function subscribedPlan(row: SubscriptionRow): PlanId {
  return isPlanId(row.plan_id) ? row.plan_id : "free";
}

/**
 * Derives the effective plan from a subscription row at time `now`.
 * Pure so tests can exercise every state without touching the database.
 */
export function resolveEffectivePlan(row: SubscriptionRow | null, now = Date.now()): EffectivePlan {
  const catalog = getPlanCatalog();
  const free: EffectivePlan = {
    plan: catalog.free,
    subscribedPlanId: null,
    state: "free",
    subscription: null,
    paid: false,
    paidUntil: null,
    graceUntil: null,
  };
  if (!row) return free;

  const planId = subscribedPlan(row);
  const plan = catalog[planId];
  const periodEnd = row.current_period_end;
  const periodStillRunning = periodEnd === null || periodEnd > now;
  const base = { subscribedPlanId: planId, subscription: row, graceUntil: null as number | null };

  switch (row.status) {
    case "active": {
      if (row.cancel_at_period_end) {
        const until = row.cancel_at ?? periodEnd;
        if (until !== null && until <= now) {
          return { ...base, plan: catalog.free, state: "cancelled", paid: false, paidUntil: null };
        }
        return { ...base, plan, state: "cancel_scheduled", paid: true, paidUntil: until };
      }
      // A period that ended without a renewal event means the webhook is late or
      // the provider is retrying payment; keep paid access for the grace window.
      if (!periodStillRunning) {
        const graceUntil = (periodEnd ?? now) + getConfig().billing.pastDueGraceDays * DAY;
        if (graceUntil > now) return { ...base, plan, state: "past_due_grace", paid: true, paidUntil: graceUntil, graceUntil };
        return { ...base, plan: catalog.free, state: "expired", paid: false, paidUntil: null };
      }
      return { ...base, plan, state: "active", paid: true, paidUntil: periodEnd };
    }
    case "trialing": {
      const until = row.trial_end ?? periodEnd;
      if (until !== null && until <= now) {
        return { ...base, plan: catalog.free, state: "expired", paid: false, paidUntil: null };
      }
      return { ...base, plan, state: row.cancel_at_period_end ? "cancel_scheduled" : "trialing", paid: true, paidUntil: until };
    }
    case "past_due": {
      // Provider is retrying payment (Stripe Smart Retries). Keep entitlements for
      // the configured grace window measured from the missed period end.
      const anchor = periodEnd ?? row.updated_at;
      const graceUntil = anchor + getConfig().billing.pastDueGraceDays * DAY;
      if (graceUntil > now) return { ...base, plan, state: "past_due_grace", paid: true, paidUntil: graceUntil, graceUntil };
      return { ...base, plan: catalog.free, state: "past_due", paid: false, paidUntil: null, graceUntil };
    }
    case "canceled":
      return { ...base, plan: catalog.free, state: "cancelled", paid: false, paidUntil: null };
    case "incomplete":
      return { ...base, plan: catalog.free, state: "incomplete", paid: false, paidUntil: null };
    case "incomplete_expired":
    case "unpaid":
      return { ...base, plan: catalog.free, state: "expired", paid: false, paidUntil: null };
    case "paused":
      return { ...base, plan: catalog.free, state: "paused", paid: false, paidUntil: null };
    default:
      return { ...base, plan: catalog.free, state: "expired", paid: false, paidUntil: null };
  }
}

export function getEffectivePlan(userId: string, now = Date.now()): EffectivePlan {
  return resolveEffectivePlan(getCurrentSubscription(userId), now);
}

/** Convenience: the plan object only. */
export function getUserPlan(userId: string): Plan {
  return getEffectivePlan(userId).plan;
}

// ---------------------------------------------------------------------------
// Usage periods

function calendarMonth(now: number): UsagePeriod {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
  return { start, end, source: "calendar" };
}

/**
 * The window usage is counted in. Paid subscriptions use the provider's
 * billing period (so renewals — not the 1st of the month — reset usage); the
 * Free plan uses the calendar month. When a subscription lapses the user is
 * back on the calendar month like any other Free user.
 */
export function getUsagePeriod(effective: EffectivePlan, now = Date.now()): UsagePeriod {
  const sub = effective.subscription;
  if (
    effective.paid &&
    sub &&
    sub.current_period_start !== null &&
    sub.current_period_end !== null &&
    sub.current_period_start <= now &&
    sub.current_period_end > sub.current_period_start
  ) {
    // During past-due grace the period has technically ended; keep counting in
    // it so the user is not handed a fresh quota for an unpaid period.
    return { start: sub.current_period_start, end: Math.max(sub.current_period_end, now + 1), source: "subscription" };
  }
  return calendarMonth(now);
}

function countUsageInPeriod(userId: string, kind: UsageKind, period: UsagePeriod): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS total FROM usage_events WHERE user_id = ? AND kind = ? AND created_at >= ? AND created_at < ?",
      )
      .get(userId, kind, period.start, period.end) as { total: number }
  ).total;
}

function countOpenReservationsInPeriod(userId: string, kind: UsageKind, period: UsagePeriod): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS total FROM quota_reservations
         WHERE user_id = ? AND kind = ? AND consumed_at IS NULL AND released_at IS NULL AND created_at >= ? AND created_at < ?`,
      )
      .get(userId, kind, period.start, period.end) as { total: number }
  ).total;
}

export function limitFor(plan: Plan, kind: UsageKind): number {
  return kind === "analysis" ? plan.analysisLimit : plan.testRunLimit;
}

/** Usage for `kind` in the current period, including open reservations. */
export function getQuotaUsage(userId: string, kind: UsageKind, now = Date.now()): QuotaUsage & { period: UsagePeriod } {
  const effective = getEffectivePlan(userId, now);
  const period = getUsagePeriod(effective, now);
  const limit = limitFor(effective.plan, kind);
  const used = countUsageInPeriod(userId, kind, period);
  const reserved = countOpenReservationsInPeriod(userId, kind, period);
  return { used, reserved, limit, remaining: Math.max(0, limit - used - reserved), resetAt: period.end, period };
}

// ---------------------------------------------------------------------------
// Entitlement checks

export interface QuotaDenial {
  kind: UsageKind;
  currentUsage: number;
  limit: number;
  resetAt: number;
  planId: PlanId;
  requiredPlan: PlanId | null;
}

export type EntitlementResult =
  | { allowed: true }
  | { allowed: false; reason: "quota"; quota: QuotaDenial }
  | { allowed: false; reason: "plan"; requiredPlan: PlanId | null; message: string }
  | { allowed: false; reason: "size"; maxExtensionSize: number; requiredPlan: PlanId | null };

export function canAnalyze(userId: string, now = Date.now()): EntitlementResult {
  return quotaCheck(userId, "analysis", now);
}

export function canRunTests(userId: string, now = Date.now()): EntitlementResult {
  return quotaCheck(userId, "test_run", now);
}

function quotaCheck(userId: string, kind: UsageKind, now: number): EntitlementResult {
  const effective = getEffectivePlan(userId, now);
  const usage = getQuotaUsage(userId, kind, now);
  if (usage.remaining > 0) return { allowed: true };
  return {
    allowed: false,
    reason: "quota",
    quota: {
      kind,
      currentUsage: usage.used + usage.reserved,
      limit: usage.limit,
      resetAt: usage.resetAt,
      planId: effective.plan.id,
      requiredPlan: smallestPlanWithLimit(getPlanCatalog(), kind, effective.plan.id),
    },
  };
}

export function canUploadPackage(userId: string, sizeBytes: number): EntitlementResult {
  const plan = getUserPlan(userId);
  if (sizeBytes <= plan.maxExtensionSize) return { allowed: true };
  const bigger = Object.values(getPlanCatalog())
    .filter((candidate) => candidate.rank > plan.rank && candidate.maxExtensionSize >= sizeBytes)
    .sort((a, b) => a.rank - b.rank)[0];
  return { allowed: false, reason: "size", maxExtensionSize: plan.maxExtensionSize, requiredPlan: bigger?.id ?? null };
}

export function canCreateShare(userId: string, expiresInHours: number | null): EntitlementResult {
  const plan = getUserPlan(userId);
  if (!plan.sharingEnabled) {
    return { allowed: false, reason: "plan", requiredPlan: firstPlanWith((p) => p.sharingEnabled, plan), message: "Report sharing is not included in your plan." };
  }
  const permanent = expiresInHours === null || expiresInHours === 0;
  if (plan.shareMaxExpiryHours === 0) return { allowed: true };
  if (permanent || (expiresInHours ?? 0) > plan.shareMaxExpiryHours) {
    return {
      allowed: false,
      reason: "plan",
      requiredPlan: firstPlanWith((p) => p.shareMaxExpiryHours === 0, plan),
      message: `Your plan allows share links of up to ${plan.shareMaxExpiryHours / 24} days.`,
    };
  }
  return { allowed: true };
}

export function canUseAdvancedDiagnostics(userId: string): EntitlementResult {
  const plan = getUserPlan(userId);
  if (plan.advancedDiagnostics) return { allowed: true };
  return {
    allowed: false,
    reason: "plan",
    requiredPlan: firstPlanWith((p) => p.advancedDiagnostics, plan),
    message: "Runtime log and network evidence downloads are available on paid plans.",
  };
}

export function getMaxConcurrentRuns(userId: string): number {
  return getUserPlan(userId).maxConcurrentRuns;
}

export function getMaxExtensionSize(userId: string): number {
  return getUserPlan(userId).maxExtensionSize;
}

export function hasPriorityExecution(userId: string): boolean {
  return getUserPlan(userId).priorityExecution;
}

export function getRetentionForUser(userId: string): { historyRetentionMs: number; artifactRetentionMs: number; packageRetentionMs: number } {
  const plan = getUserPlan(userId);
  return {
    historyRetentionMs: plan.historyRetentionDays * DAY,
    artifactRetentionMs: plan.artifactRetentionDays * DAY,
    packageRetentionMs: plan.packageRetentionDays * DAY,
  };
}

function firstPlanWith(predicate: (plan: Plan) => boolean, current: Plan): PlanId | null {
  const match = Object.values(getPlanCatalog())
    .filter((candidate) => candidate.rank > current.rank && predicate(candidate))
    .sort((a, b) => a.rank - b.rank)[0];
  return match?.id ?? null;
}

/** Quota limits for a plan id (used when reserving inside a transaction). */
export function planLimits(planId: PlanId): { analysis: number; test_run: number } {
  const plan = getPlan(planId);
  return { analysis: plan.analysisLimit, test_run: plan.testRunLimit };
}
