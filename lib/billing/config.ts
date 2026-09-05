import "server-only";
import { getConfig } from "@/lib/config/env";
import { buildPlanCatalog, orderedPlans } from "./plans";
import type { Plan, PlanId } from "./types";

/**
 * Server-side plan catalog bound to the validated application configuration.
 * Memoized per config instance; tests reset it through resetConfigCache().
 */
let cachedFor: ReturnType<typeof getConfig> | null = null;
let cachedCatalog: Record<PlanId, Plan> | null = null;

export function getPlanCatalog(): Record<PlanId, Plan> {
  const config = getConfig();
  if (cachedCatalog && cachedFor === config) return cachedCatalog;
  cachedCatalog = buildPlanCatalog({
    currency: config.billing.currency,
    amounts: config.billing.amounts,
    priceIds: config.billing.priceIds,
    hardMaxExtensionSize: config.maxExtensionSize,
  });
  cachedFor = config;
  return cachedCatalog;
}

export function getPlan(id: PlanId): Plan {
  return getPlanCatalog()[id];
}

export function listPlans(): Plan[] {
  return orderedPlans(getPlanCatalog());
}

/** Server-only mapping from a paid plan to its configured provider price id. */
export function priceIdForPlan(planId: PlanId): string | null {
  if (planId === "free") return null;
  return getConfig().billing.priceIds[planId];
}

/** Reverse lookup used when normalizing provider subscriptions; unknown price → null. */
export function planIdForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  const ids = getConfig().billing.priceIds;
  if (ids.pro === priceId) return "pro";
  if (ids.business === priceId) return "business";
  return null;
}

/** Public, secret-free projection of a plan for API responses and pages. */
export interface PlanView {
  id: PlanId;
  name: string;
  description: string;
  audience: string;
  price: { amount: number | null; currency: string; interval: "month"; formatted: string };
  purchasable: boolean;
  rank: number;
  highlights: string[];
  limits: {
    analysisLimit: number;
    testRunLimit: number;
    maxExtensionSize: number;
    maxConcurrentRuns: number;
    historyRetentionDays: number;
    artifactRetentionDays: number;
    packageRetentionDays: number;
    aiRequestLimit: number;
  };
  features: {
    sharingEnabled: boolean;
    shareMaxExpiryHours: number;
    advancedDiagnostics: boolean;
    priorityExecution: boolean;
    aiEnabled: boolean;
  };
}

export function toPlanView(plan: Plan, formatted: string): PlanView {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    audience: plan.audience,
    price: { amount: plan.price.amount, currency: plan.price.currency, interval: plan.price.interval, formatted },
    purchasable: plan.purchasable,
    rank: plan.rank,
    highlights: plan.highlights,
    limits: {
      analysisLimit: plan.analysisLimit,
      testRunLimit: plan.testRunLimit,
      maxExtensionSize: plan.maxExtensionSize,
      maxConcurrentRuns: plan.maxConcurrentRuns,
      historyRetentionDays: plan.historyRetentionDays,
      artifactRetentionDays: plan.artifactRetentionDays,
      packageRetentionDays: plan.packageRetentionDays,
      aiRequestLimit: plan.aiEnabled ? plan.aiRequestLimit : 0,
    },
    features: {
      sharingEnabled: plan.sharingEnabled,
      shareMaxExpiryHours: plan.shareMaxExpiryHours,
      advancedDiagnostics: plan.advancedDiagnostics,
      priorityExecution: plan.priorityExecution,
      aiEnabled: plan.aiEnabled && plan.aiRequestLimit > 0,
    },
  };
}
