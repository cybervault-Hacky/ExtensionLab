/**
 * @deprecated Phase 7 moved plans to `lib/billing`. This module remains only
 * so older imports keep compiling; it returns the configured **Free** plan and
 * knows nothing about a user's subscription. Use
 * `getEffectivePlan(userId)` / `getUserPlan(userId)` from
 * `@/lib/billing/entitlements` instead — they are the server-side authority.
 */
import { getPlan } from "@/lib/billing/config";
import type { Plan as BillingPlan } from "@/lib/billing/types";

export interface Plan {
  id: string;
  name: string;
  analysisLimit: number;
  testRunLimit: number;
  maxExtensionSize: number;
  maxConcurrentRuns: number;
  historyRetentionDays: number;
}

function legacyView(plan: BillingPlan): Plan {
  return {
    id: plan.id,
    name: plan.name,
    analysisLimit: plan.analysisLimit,
    testRunLimit: plan.testRunLimit,
    maxExtensionSize: plan.maxExtensionSize,
    maxConcurrentRuns: plan.maxConcurrentRuns,
    historyRetentionDays: plan.historyRetentionDays,
  };
}

/** @deprecated Returns the Free plan regardless of user. See module note. */
export function getActivePlan(): Plan {
  return legacyView(getPlan("free"));
}
