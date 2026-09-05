import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlanCatalog, formatPlanAmount, isPaidPlanId, orderedPlans, planComparisonRows, smallestPlanWithLimit } from "@/lib/billing/plans";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { resolveEffectivePlan, getEffectivePlan, getQuotaUsage, canAnalyze, canRunTests, canCreateShare, canUploadPackage, canUseAdvancedDiagnostics, getMaxConcurrentRuns, getRetentionForUser, getUsagePeriod } from "@/lib/billing/entitlements";
import { upsertSubscription } from "@/lib/db/repositories/billing";
import { recordUsage } from "@/lib/db/repositories/usage";
import { loadConfig, resetConfigCache, ConfigError } from "@/lib/config/env";
import type { SubscriptionRow } from "@/lib/db/schema/types";
import { setupBillingHarness, makeUser, type Harness } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

describe("plan catalog", () => {
  const base = { currency: "inr", amounts: { pro: 79900, business: 249900 }, priceIds: { pro: "price_pro", business: null as string | null } };

  it("contains exactly free, pro and business in rank order", () => {
    const catalog = buildPlanCatalog(base);
    expect(orderedPlans(catalog).map((plan) => plan.id)).toEqual(["free", "pro", "business"]);
    expect(Object.keys(catalog)).toHaveLength(3);
  });

  it("is configuration driven: env overrides per plan and legacy PLAN_* names map to Free only", () => {
    const catalog = buildPlanCatalog({
      ...base,
      env: { PLAN_TEST_LIMIT: "2", PLAN_PRO_TEST_LIMIT: "300", PLAN_BUSINESS_SHARING_ENABLED: "false" } as unknown as NodeJS.ProcessEnv,
    });
    expect(catalog.free.testRunLimit).toBe(2);
    expect(catalog.pro.testRunLimit).toBe(300);
    expect(catalog.business.testRunLimit).toBe(500);
    expect(catalog.business.sharingEnabled).toBe(false);
  });

  it("never lets a plan exceed the platform's hard extension size limit", () => {
    const catalog = buildPlanCatalog({ ...base, env: { PLAN_PRO_MAX_EXTENSION_SIZE: String(MAX_EXTENSION_SIZE * 10) } as unknown as NodeJS.ProcessEnv });
    expect(catalog.pro.maxExtensionSize).toBe(MAX_EXTENSION_SIZE);
  });

  it("marks paid plans purchasable only when a price id is configured and never hardcodes prices", () => {
    const catalog = buildPlanCatalog(base);
    expect(catalog.pro.purchasable).toBe(true);
    expect(catalog.business.purchasable).toBe(false);
    expect(catalog.free.purchasable).toBe(false);
    const unpriced = buildPlanCatalog({ ...base, amounts: { pro: null, business: null } });
    expect(unpriced.pro.price.amount).toBeNull();
    expect(formatPlanAmount(unpriced.pro)).toMatch(/contact/i);
    expect(formatPlanAmount(catalog.free)).toBe("Free");
    expect(formatPlanAmount(catalog.pro)).toMatch(/799/);
  });

  it("derives the comparison table and the smallest sufficient plan from the same catalog", () => {
    const catalog = buildPlanCatalog(base);
    const rows = planComparisonRows(catalog);
    expect(rows.find((row) => row.key === "tests")?.values).toEqual({ free: "5", pro: "100", business: "500" });
    expect(smallestPlanWithLimit(catalog, "test_run", "free")).toBe("pro");
    expect(smallestPlanWithLimit(catalog, "test_run", "business")).toBeNull();
    expect(isPaidPlanId("pro")).toBe(true);
    expect(isPaidPlanId("free")).toBe(false);
    expect(isPaidPlanId("enterprise")).toBe(false);
  });
});

describe("billing configuration validation", () => {
  afterAll(() => resetConfigCache());
  const prod: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    APP_ENV: "production",
    APP_URL: "https://lab.example.com",
    SESSION_SECRET: "s".repeat(48),
    EMAIL_PROVIDER: "noop",
    DATABASE_URL: "sqlite:/tmp/el-billing-config.sqlite",
    PATH: process.env.PATH,
  };

  it("defaults to disabled in production and rejects the fake provider there", () => {
    expect(loadConfig({ ...prod }).billing.provider).toBe("disabled");
    expect(() => loadConfig({ ...prod, BILLING_PROVIDER: "fake" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...prod, BILLING_FAKE_WEBHOOK_SECRET: "x" })).toThrow(/FAKE/);
  });

  it("requires keys, webhook secret, a live key and at least one price id for stripe in production", () => {
    expect(() => loadConfig({ ...prod, BILLING_PROVIDER: "stripe" })).toThrow(/BILLING_SECRET_KEY/);
    expect(() =>
      loadConfig({ ...prod, BILLING_PROVIDER: "stripe", BILLING_SECRET_KEY: "sk_test_abc", BILLING_WEBHOOK_SECRET: "whsec_x", BILLING_PRO_PRICE_ID: "price_1" }),
    ).toThrow(/live/);
    expect(() =>
      loadConfig({ ...prod, BILLING_PROVIDER: "stripe", BILLING_SECRET_KEY: "sk_live_abc", BILLING_WEBHOOK_SECRET: "whsec_x" }),
    ).toThrow(/PRICE_ID/);
    const ok = loadConfig({ ...prod, BILLING_PROVIDER: "stripe", BILLING_SECRET_KEY: "sk_live_abc", BILLING_WEBHOOK_SECRET: "whsec_x", BILLING_PRO_PRICE_ID: "price_1" });
    expect(ok.billing.provider).toBe("stripe");
    expect(ok.billing.priceIds.pro).toBe("price_1");
  });

  it("defaults to the fake provider outside production and keeps secrets out of describeConfig", async () => {
    const dev = loadConfig({ NODE_ENV: "development", APP_ENV: "development", BILLING_SECRET_KEY: "sk_test_super_secret", BILLING_WEBHOOK_SECRET: "whsec_hidden", PATH: process.env.PATH });
    expect(dev.billing.provider).toBe("fake");
    const { describeConfig } = await import("@/lib/config/env");
    const described = JSON.stringify(describeConfig(dev));
    expect(described).not.toContain("sk_test_super_secret");
    expect(described).not.toContain("whsec_hidden");
  });
});

function row(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  const now = Date.now();
  return {
    id: "sub_local",
    user_id: "usr_x",
    provider: "fake",
    provider_customer_id: "cus_x",
    provider_subscription_id: "sub_remote",
    provider_price_id: "price_pro_test",
    plan_id: "pro",
    status: "active",
    current_period_start: now - 10 * DAY,
    current_period_end: now + 20 * DAY,
    cancel_at_period_end: 0,
    cancel_at: null,
    canceled_at: null,
    trial_end: null,
    ended_at: null,
    last_event_at: now,
    created_at: now - 10 * DAY,
    updated_at: now,
    ...overrides,
  };
}

describe("effective plan state machine", () => {
  let harness: Harness;
  beforeAll(() => {
    harness = setupBillingHarness({ BILLING_PAST_DUE_GRACE_DAYS: "7" });
  });
  afterAll(() => harness.teardown());

  it("free when there is no subscription", () => {
    const effective = resolveEffectivePlan(null);
    expect(effective.plan.id).toBe("free");
    expect(effective.state).toBe("free");
    expect(effective.paid).toBe(false);
  });

  it("active → paid plan until period end", () => {
    const effective = resolveEffectivePlan(row({}));
    expect(effective.plan.id).toBe("pro");
    expect(effective.state).toBe("active");
    expect(effective.paid).toBe(true);
  });

  it("trialing → paid until trial end, then expired", () => {
    const now = Date.now();
    expect(resolveEffectivePlan(row({ status: "trialing", trial_end: now + DAY }), now)).toMatchObject({ state: "trialing", paid: true });
    expect(resolveEffectivePlan(row({ status: "trialing", trial_end: now - 1 }), now)).toMatchObject({ state: "expired", paid: false });
  });

  it("cancel_at_period_end keeps access until the period ends and then falls back to free without deleting anything", () => {
    const now = Date.now();
    const scheduled = resolveEffectivePlan(row({ cancel_at_period_end: 1, cancel_at: now + 5 * DAY }), now);
    expect(scheduled).toMatchObject({ state: "cancel_scheduled", paid: true });
    expect(scheduled.plan.id).toBe("pro");
    expect(scheduled.paidUntil).toBe(now + 5 * DAY);
    const lapsed = resolveEffectivePlan(row({ cancel_at_period_end: 1, cancel_at: now - 1, current_period_end: now - 1 }), now);
    expect(lapsed).toMatchObject({ state: "cancelled", paid: false });
    expect(lapsed.plan.id).toBe("free");
    expect(lapsed.subscribedPlanId).toBe("pro");
  });

  it("past_due keeps paid entitlements during the grace window, then downgrades", () => {
    const now = Date.now();
    const inGrace = resolveEffectivePlan(row({ status: "past_due", current_period_end: now - 2 * DAY }), now);
    expect(inGrace).toMatchObject({ state: "past_due_grace", paid: true });
    expect(inGrace.plan.id).toBe("pro");
    expect(inGrace.graceUntil).toBe(now - 2 * DAY + 7 * DAY);
    const lapsed = resolveEffectivePlan(row({ status: "past_due", current_period_end: now - 8 * DAY }), now);
    expect(lapsed).toMatchObject({ state: "past_due", paid: false });
    expect(lapsed.plan.id).toBe("free");
  });

  it("active subscription whose period elapsed without a renewal event is tolerated for the grace window only", () => {
    const now = Date.now();
    expect(resolveEffectivePlan(row({ current_period_end: now - DAY }), now)).toMatchObject({ state: "past_due_grace", paid: true });
    expect(resolveEffectivePlan(row({ current_period_end: now - 8 * DAY }), now)).toMatchObject({ state: "expired", paid: false });
  });

  it("canceled / unpaid / incomplete / paused grant free entitlements", () => {
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as const) {
      const effective = resolveEffectivePlan(row({ status }));
      expect(effective.paid, status).toBe(false);
      expect(effective.plan.id, status).toBe("free");
    }
  });

  it("an unknown plan id on a row can never grant paid features", () => {
    const effective = resolveEffectivePlan(row({ plan_id: "enterprise" }));
    expect(effective.plan.id).toBe("free");
  });
});

describe("entitlement service against the database", () => {
  let harness: Harness;
  beforeAll(() => {
    harness = setupBillingHarness({ PLAN_TEST_LIMIT: "2", PLAN_ANALYSIS_LIMIT: "3" });
  });
  afterAll(() => harness.teardown());

  function subscribe(userId: string, planId: "pro" | "business", overrides: Partial<Parameters<typeof upsertSubscription>[0]> = {}) {
    const now = Date.now();
    return upsertSubscription({
      userId,
      provider: "fake",
      providerCustomerId: `cus_${userId}`,
      providerSubscriptionId: `sub_${userId}`,
      providerPriceId: planId === "pro" ? "price_pro_test" : "price_business_test",
      planId,
      status: "active",
      currentPeriodStart: now - 5 * DAY,
      currentPeriodEnd: now + 25 * DAY,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      canceledAt: null,
      trialEnd: null,
      endedAt: null,
      eventAt: now,
      ...overrides,
    });
  }

  it("free users hit the free quota and are told which plan lifts it, with a calendar-month reset", () => {
    const user = makeUser();
    recordUsage(user.id, "test_run");
    recordUsage(user.id, "test_run");
    const verdict = canRunTests(user.id);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed && verdict.reason === "quota") {
      expect(verdict.quota).toMatchObject({ kind: "test_run", currentUsage: 2, limit: 2, planId: "free", requiredPlan: "pro" });
      const period = getUsagePeriod(getEffectivePlan(user.id));
      expect(period.source).toBe("calendar");
      expect(verdict.quota.resetAt).toBe(period.end);
    }
    expect(canAnalyze(user.id).allowed).toBe(true);
  });

  it("paid users get plan limits and a usage period aligned with the subscription period", () => {
    const user = makeUser();
    const now = Date.now();
    subscribe(user.id, "pro");
    // Usage recorded *before* this billing period must not count.
    recordUsage(user.id, "test_run", now - 10 * DAY);
    for (let i = 0; i < 3; i += 1) recordUsage(user.id, "test_run");
    const usage = getQuotaUsage(user.id, "test_run");
    expect(usage.limit).toBe(100);
    expect(usage.used).toBe(3);
    expect(usage.period.source).toBe("subscription");
    expect(canRunTests(user.id).allowed).toBe(true);
    expect(getMaxConcurrentRuns(user.id)).toBe(2);
    expect(canUseAdvancedDiagnostics(user.id).allowed).toBe(true);
    expect(canCreateShare(user.id, null).allowed).toBe(true);
    expect(getRetentionForUser(user.id).artifactRetentionMs).toBe(30 * DAY);
  });

  it("free users can share for a bounded time only; permanent links require a paid plan", () => {
    const user = makeUser();
    expect(canCreateShare(user.id, 24).allowed).toBe(true);
    expect(canCreateShare(user.id, 168).allowed).toBe(true);
    const permanent = canCreateShare(user.id, null);
    expect(permanent.allowed).toBe(false);
    if (!permanent.allowed && permanent.reason === "plan") expect(permanent.requiredPlan).toBe("pro");
    expect(canCreateShare(user.id, 720).allowed).toBe(false);
    expect(canUseAdvancedDiagnostics(user.id).allowed).toBe(false);
  });

  it("size entitlement respects the plan and the hard limit", () => {
    const user = makeUser();
    expect(canUploadPackage(user.id, 1024).allowed).toBe(true);
    expect(canUploadPackage(user.id, MAX_EXTENSION_SIZE + 1).allowed).toBe(false);
  });

  it("downgrade/expiry moves the user back to free entitlements while keeping their data", () => {
    const user = makeUser();
    const now = Date.now();
    subscribe(user.id, "business");
    expect(getEffectivePlan(user.id).plan.id).toBe("business");
    for (let i = 0; i < 3; i += 1) recordUsage(user.id, "test_run");
    subscribe(user.id, "business", { status: "canceled", endedAt: now, eventAt: now + 1 });
    const effective = getEffectivePlan(user.id);
    expect(effective.plan.id).toBe("free");
    expect(effective.state).toBe("cancelled");
    // Free limit (2) is now exceeded by this month's usage → blocked, but nothing was deleted.
    expect(canRunTests(user.id).allowed).toBe(false);
    expect(getQuotaUsage(user.id, "test_run").used).toBe(3);
  });

  it("ignores out-of-order provider events when applying subscription state", () => {
    const user = makeUser();
    const now = Date.now();
    subscribe(user.id, "pro", { eventAt: now });
    const stale = subscribe(user.id, "pro", { status: "canceled", eventAt: now - 60_000 });
    expect(stale.changed).toBe(false);
    expect(getEffectivePlan(user.id).state).toBe("active");
  });
});
