import "server-only";
import { getDb, transaction } from "@/lib/db/client";
import {
  findUserIdByProviderCustomer,
  getSubscriptionByProviderId,
  upsertSubscription,
} from "@/lib/db/repositories/billing";
import { recordAuditEvent, type AuditEventType } from "@/lib/db/repositories/audit";
import type { SubscriptionRow } from "@/lib/db/schema/types";
import { logger, recordMetric } from "@/lib/observability/logger";
import { planIdForPriceId } from "./config";
import { getPlan } from "./config";
import { isPlanId } from "./plans";
import type { PlanId, ProviderSubscription } from "./types";

/**
 * Applies a provider subscription snapshot to the local database.
 *
 * This is the *only* writer of `subscriptions` rows. Callers are the webhook
 * processor (authoritative), the post-checkout confirmation poll and the
 * cancel/reactivate actions (which apply the provider's response). The plan
 * is resolved from the provider price id — metadata is only a fallback for
 * provider objects created without a price we recognize, and never from
 * anything the browser sent.
 */

export interface ApplyResult {
  row: SubscriptionRow;
  changed: boolean;
  previous: SubscriptionRow | null;
  userId: string;
}

export function resolvePlanForSubscription(sub: ProviderSubscription): PlanId {
  const byPrice = planIdForPriceId(sub.priceId);
  if (byPrice) return byPrice;
  if (isPlanId(sub.metadata.planId) && sub.metadata.planId !== "free") {
    logger.warn("billing.plan_from_metadata", { component: "billing", planId: sub.metadata.planId, errorCode: "INVALID_PLAN" });
    return sub.metadata.planId;
  }
  // A subscription for an unknown price grants nothing paid.
  return "free";
}

/**
 * Finds the local owner of a provider subscription: the existing row, the
 * customer mapping, or (only as a last resort for brand-new customers) the
 * userId metadata we attached at checkout.
 */
export function resolveOwner(provider: string, sub: ProviderSubscription): string | null {
  const existing = getSubscriptionByProviderId(provider, sub.id);
  if (existing) return existing.user_id;
  const byCustomer = findUserIdByProviderCustomer(provider, sub.customerId);
  if (byCustomer) return byCustomer;
  const metaUser = sub.metadata.userId;
  if (metaUser && userExists(metaUser)) return metaUser;
  return null;
}

function userExists(userId: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM users WHERE id = ?").get(userId));
}

export function applyProviderSubscription(input: {
  provider: string;
  subscription: ProviderSubscription;
  eventAt: number;
  userId?: string | null;
  source: "webhook" | "confirm" | "action" | "reconcile";
}): ApplyResult | null {
  const userId = input.userId ?? resolveOwner(input.provider, input.subscription);
  if (!userId) {
    logger.warn("billing.subscription_unowned", { component: "billing", provider: input.provider, source: input.source });
    return null;
  }
  const sub = input.subscription;
  const planId = resolvePlanForSubscription(sub);
  return transaction(getDb(), () => {
    const { row, changed, previous } = upsertSubscription({
      userId,
      provider: input.provider,
      providerCustomerId: sub.customerId,
      providerSubscriptionId: sub.id,
      providerPriceId: sub.priceId,
      planId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      cancelAt: sub.cancelAt,
      canceledAt: sub.canceledAt,
      trialEnd: sub.trialEnd,
      endedAt: sub.endedAt,
      eventAt: input.eventAt,
    });
    if (changed) {
      const audit = describeTransition(previous, row);
      if (audit) recordAuditEvent({ userId, type: audit.type, detail: audit.detail });
      recordMetric("billing.subscription_changed", 1, { to: row.status, plan: row.plan_id, source: input.source });
      logger.info("billing.subscription_changed", {
        component: "billing",
        userId,
        subscriptionId: row.id,
        provider: input.provider,
        planId: row.plan_id,
        from: previous?.status ?? "none",
        to: row.status,
        cancelAtPeriodEnd: row.cancel_at_period_end === 1,
        source: input.source,
        result: "ok",
      });
    }
    return { row, changed, previous, userId };
  });
}

function describeTransition(previous: SubscriptionRow | null, row: SubscriptionRow): { type: AuditEventType; detail: string } | null {
  const planName = isPlanId(row.plan_id) ? getPlan(row.plan_id).name : row.plan_id;
  const paidNow = row.status === "active" || row.status === "trialing";
  const paidBefore = previous ? previous.status === "active" || previous.status === "trialing" : false;
  if (!previous) {
    return { type: paidNow ? "subscription_activated" : "subscription_created", detail: `${planName} · ${row.status}` };
  }
  if (previous.plan_id !== row.plan_id && paidNow) {
    const prevRank = isPlanId(previous.plan_id) ? getPlan(previous.plan_id).rank : -1;
    const nextRank = isPlanId(row.plan_id) ? getPlan(row.plan_id).rank : -1;
    return { type: nextRank > prevRank ? "subscription_upgraded" : "subscription_downgraded", detail: `${planName}` };
  }
  if (row.status === "canceled" && previous.status !== "canceled") {
    return { type: "subscription_expired", detail: `${planName} ended` };
  }
  if (row.cancel_at_period_end === 1 && previous.cancel_at_period_end === 0) {
    return { type: "subscription_cancelled", detail: `${planName} · cancels at period end` };
  }
  if (row.cancel_at_period_end === 0 && previous.cancel_at_period_end === 1 && paidNow) {
    return { type: "subscription_reactivated", detail: `${planName}` };
  }
  if (!paidBefore && paidNow) {
    return { type: "subscription_activated", detail: `${planName}` };
  }
  return { type: "billing_state_changed", detail: `${planName} · ${previous.status} → ${row.status}` };
}
