import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { PLAN_IDS, type Plan, type PlanId } from "./types";

/**
 * Central plan catalog.
 *
 * Every limit and feature flag the entitlement service, the API and the
 * pricing/billing pages use comes from here, so the UI can never disagree
 * with what the server enforces. Values are configuration-driven:
 *
 *   PLAN_<PLAN>_ANALYSIS_LIMIT, PLAN_<PLAN>_TEST_LIMIT,
 *   PLAN_<PLAN>_MAX_EXTENSION_SIZE, PLAN_<PLAN>_MAX_CONCURRENT_RUNS,
 *   PLAN_<PLAN>_HISTORY_RETENTION_DAYS, PLAN_<PLAN>_ARTIFACT_RETENTION_DAYS,
 *   PLAN_<PLAN>_PACKAGE_RETENTION_DAYS
 *
 * The Phase 5 variables (PLAN_ANALYSIS_LIMIT, PLAN_TEST_LIMIT,
 * PLAN_MAX_EXTENSION_SIZE, PLAN_MAX_CONCURRENT_RUNS,
 * PLAN_HISTORY_RETENTION_DAYS) keep configuring the Free plan.
 *
 * Prices: amounts come from BILLING_<PLAN>_AMOUNT (minor units) and are
 * informational; the provider price object referenced by
 * BILLING_<PLAN>_PRICE_ID is what actually gets charged. A paid plan is
 * purchasable only when its price id is configured.
 */

const DAY_DEFAULTS = {
  free: { history: 30, artifact: 7, package: 14 },
  pro: { history: 180, artifact: 30, package: 60 },
  business: { history: 365, artifact: 90, package: 180 },
} as const;

const DEFAULTS: Record<PlanId, Omit<Plan, "price" | "purchasable">> = {
  free: {
    id: "free",
    name: "Free",
    rank: 0,
    description: "Everything you need to inspect an extension and try automated testing.",
    audience: "For trying ExtensionLab and occasional checks.",
    analysisLimit: 10,
    testRunLimit: 5,
    maxExtensionSize: MAX_EXTENSION_SIZE,
    maxConcurrentRuns: 1,
    historyRetentionDays: DAY_DEFAULTS.free.history,
    artifactRetentionDays: DAY_DEFAULTS.free.artifact,
    packageRetentionDays: DAY_DEFAULTS.free.package,
    sharingEnabled: true,
    shareMaxExpiryHours: 168,
    advancedDiagnostics: false,
    priorityExecution: false,
    highlights: ["Static analysis and health score", "Automated tests in an isolated browser", "Reports with 7-day share links"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    rank: 1,
    description: "Higher limits, runtime evidence downloads and longer history for individual developers.",
    audience: "For developers shipping extensions regularly.",
    analysisLimit: 200,
    testRunLimit: 100,
    maxExtensionSize: MAX_EXTENSION_SIZE,
    maxConcurrentRuns: 2,
    historyRetentionDays: DAY_DEFAULTS.pro.history,
    artifactRetentionDays: DAY_DEFAULTS.pro.artifact,
    packageRetentionDays: DAY_DEFAULTS.pro.package,
    sharingEnabled: true,
    shareMaxExpiryHours: 0,
    advancedDiagnostics: true,
    priorityExecution: false,
    highlights: ["Screenshots, runtime logs and network evidence", "Permanent share links", "Two runs at a time"],
  },
  business: {
    id: "business",
    name: "Business",
    rank: 2,
    description: "The highest limits, priority execution and the longest retention for professional teams.",
    audience: "For companies that test many extensions or run tests in CI.",
    analysisLimit: 1000,
    testRunLimit: 500,
    maxExtensionSize: MAX_EXTENSION_SIZE,
    maxConcurrentRuns: 4,
    historyRetentionDays: DAY_DEFAULTS.business.history,
    artifactRetentionDays: DAY_DEFAULTS.business.artifact,
    packageRetentionDays: DAY_DEFAULTS.business.package,
    sharingEnabled: true,
    shareMaxExpiryHours: 0,
    advancedDiagnostics: true,
    priorityExecution: true,
    highlights: ["Priority queue for automated tests", "Four runs at a time", "One-year history"],
  },
};

interface PlanEnv {
  amount: number | null;
  priceId: string | null;
  currency: string;
}

export interface PlanCatalogInput {
  env?: NodeJS.ProcessEnv;
  currency: string;
  amounts: { pro: number | null; business: number | null };
  priceIds: { pro: string | null; business: string | null };
  /** Hard cap from Phase 1 validation; plan sizes can never exceed it. */
  hardMaxExtensionSize?: number;
}

function numFromEnv(env: NodeJS.ProcessEnv, names: string[], fallback: number, min = 0): number {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= min) return parsed;
  }
  return fallback;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function buildPlan(id: PlanId, env: NodeJS.ProcessEnv, pricing: PlanEnv, hardMax: number): Plan {
  const base = DEFAULTS[id];
  const P = `PLAN_${id.toUpperCase()}_`;
  // Legacy Phase 5 variable names apply to the Free plan only.
  const legacy = id === "free";
  const maxExtensionSize = Math.min(
    hardMax,
    numFromEnv(env, [`${P}MAX_EXTENSION_SIZE`, ...(legacy ? ["PLAN_MAX_EXTENSION_SIZE"] : [])], base.maxExtensionSize, 1024),
  );
  return {
    ...base,
    analysisLimit: numFromEnv(env, [`${P}ANALYSIS_LIMIT`, ...(legacy ? ["PLAN_ANALYSIS_LIMIT"] : [])], base.analysisLimit),
    testRunLimit: numFromEnv(env, [`${P}TEST_LIMIT`, ...(legacy ? ["PLAN_TEST_LIMIT"] : [])], base.testRunLimit),
    maxExtensionSize,
    maxConcurrentRuns: numFromEnv(
      env,
      [`${P}MAX_CONCURRENT_RUNS`, ...(legacy ? ["PLAN_MAX_CONCURRENT_RUNS"] : [])],
      base.maxConcurrentRuns,
      1,
    ),
    historyRetentionDays: numFromEnv(
      env,
      [`${P}HISTORY_RETENTION_DAYS`, ...(legacy ? ["PLAN_HISTORY_RETENTION_DAYS"] : [])],
      base.historyRetentionDays,
      1,
    ),
    artifactRetentionDays: numFromEnv(
      env,
      [`${P}ARTIFACT_RETENTION_DAYS`, ...(legacy ? ["ARTIFACT_RETENTION_DAYS"] : [])],
      base.artifactRetentionDays,
      1,
    ),
    packageRetentionDays: numFromEnv(
      env,
      [`${P}PACKAGE_RETENTION_DAYS`, ...(legacy ? ["PACKAGE_RETENTION_DAYS"] : [])],
      base.packageRetentionDays,
      1,
    ),
    sharingEnabled: boolFromEnv(env, `${P}SHARING_ENABLED`, base.sharingEnabled),
    shareMaxExpiryHours: numFromEnv(env, [`${P}SHARE_MAX_EXPIRY_HOURS`], base.shareMaxExpiryHours),
    advancedDiagnostics: boolFromEnv(env, `${P}ADVANCED_DIAGNOSTICS`, base.advancedDiagnostics),
    priorityExecution: boolFromEnv(env, `${P}PRIORITY_EXECUTION`, base.priorityExecution),
    price: { amount: pricing.amount, currency: pricing.currency, interval: "month" },
    purchasable: id !== "free" && Boolean(pricing.priceId),
  };
}

/** Builds the catalog from explicit inputs (pure; used by getPlanCatalog and tests). */
export function buildPlanCatalog(input: PlanCatalogInput): Record<PlanId, Plan> {
  const env = input.env ?? process.env;
  const hardMax = input.hardMaxExtensionSize ?? MAX_EXTENSION_SIZE;
  return {
    free: buildPlan("free", env, { amount: 0, priceId: null, currency: input.currency }, hardMax),
    pro: buildPlan("pro", env, { amount: input.amounts.pro, priceId: input.priceIds.pro, currency: input.currency }, hardMax),
    business: buildPlan(
      "business",
      env,
      { amount: input.amounts.business, priceId: input.priceIds.business, currency: input.currency },
      hardMax,
    ),
  };
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

export function isPaidPlanId(value: unknown): value is Exclude<PlanId, "free"> {
  return isPlanId(value) && value !== "free";
}

/** Sorted by rank (Free first). */
export function orderedPlans(catalog: Record<PlanId, Plan>): Plan[] {
  return PLAN_IDS.map((id) => catalog[id]).sort((a, b) => a.rank - b.rank);
}

/** Smallest plan whose limit satisfies `required` for `kind`, or null when none does. */
export function smallestPlanWithLimit(
  catalog: Record<PlanId, Plan>,
  kind: "analysis" | "test_run",
  currentPlan: PlanId,
): PlanId | null {
  const key = kind === "analysis" ? "analysisLimit" : "testRunLimit";
  const current = catalog[currentPlan];
  const candidate = orderedPlans(catalog).find((plan) => plan.rank > current.rank && plan[key] > current[key]);
  return candidate?.id ?? null;
}

/** Non-secret comparison rows shared by /pricing and the billing page. */
export interface PlanComparisonRow {
  key: string;
  label: string;
  values: Record<PlanId, string>;
}

export function formatPlanAmount(plan: Plan, locale = "en-IN"): string {
  if (plan.id === "free") return "Free";
  if (plan.price.amount === null) return "Contact us";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: plan.price.currency.toUpperCase(),
      minimumFractionDigits: plan.price.amount % 100 === 0 ? 0 : 2,
    }).format(plan.price.amount / 100);
  } catch {
    return `${(plan.price.amount / 100).toFixed(2)} ${plan.price.currency.toUpperCase()}`;
  }
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function formatDays(days: number): string {
  if (days % 365 === 0) return days === 365 ? "1 year" : `${days / 365} years`;
  if (days % 30 === 0 && days >= 60) return `${days / 30} months`;
  return `${days} days`;
}

export function planComparisonRows(catalog: Record<PlanId, Plan>): PlanComparisonRow[] {
  const val = (fn: (plan: Plan) => string): Record<PlanId, string> => ({
    free: fn(catalog.free),
    pro: fn(catalog.pro),
    business: fn(catalog.business),
  });
  return [
    { key: "analyses", label: "Analyses per month", values: val((p) => `${p.analysisLimit}`) },
    { key: "tests", label: "Automated test runs per month", values: val((p) => `${p.testRunLimit}`) },
    { key: "size", label: "Extension package size", values: val((p) => formatMb(p.maxExtensionSize)) },
    { key: "concurrency", label: "Concurrent test runs", values: val((p) => `${p.maxConcurrentRuns}`) },
    { key: "history", label: "Test and report history", values: val((p) => formatDays(p.historyRetentionDays)) },
    { key: "artifacts", label: "Runtime evidence retention", values: val((p) => formatDays(p.artifactRetentionDays)) },
    {
      key: "diagnostics",
      label: "Runtime evidence downloads",
      values: val((p) => (p.advancedDiagnostics ? "Screenshots, runtime logs, network" : "Screenshots")),
    },
    {
      key: "sharing",
      label: "Report share links",
      values: val((p) =>
        !p.sharingEnabled ? "Not included" : p.shareMaxExpiryHours === 0 ? "Permanent or expiring" : `Up to ${p.shareMaxExpiryHours / 24} days`,
      ),
    },
    { key: "priority", label: "Priority execution", values: val((p) => (p.priorityExecution ? "Included" : "Standard queue")) },
  ];
}
