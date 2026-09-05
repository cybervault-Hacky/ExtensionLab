import { upsertBillingCustomer, upsertSubscription } from "@/lib/db/repositories/billing";
import { setOrganizationPlan } from "@/lib/organizations/service";
import type { PlanId } from "@/lib/billing/types";

export { setupHarness, makeUser, activatePlan, ALL_BROWSERS_HEALTHY, type Harness } from "@/tests/phase9/helpers";

/** Personal-workspace plan activation (Phase 7/9 flow). */
export function activateUserPlan(userId: string, planId: Exclude<PlanId, "free">): void {
  const now = Date.now();
  upsertBillingCustomer({ userId, provider: "fake", providerCustomerId: `cust_${userId}` });
  upsertSubscription({
    userId,
    provider: "fake",
    providerCustomerId: `cust_${userId}`,
    providerSubscriptionId: `sub_${userId}_${planId}`,
    providerPriceId: `price_${planId}_test`,
    planId,
    status: "active",
    currentPeriodStart: now - 1000,
    currentPeriodEnd: now + 30 * 24 * 3600 * 1000,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    canceledAt: null,
    trialEnd: null,
    endedAt: null,
    eventAt: now,
  });
}

/** Organization plan activation used by webhook/operator flows. */
export function activateOrganizationPlan(organizationId: string, planId: "free" | "pro" | "business", seats?: number): void {
  setOrganizationPlan({ organizationId, planId, status: "active", ...(seats ? { seats } : {}) });
}
