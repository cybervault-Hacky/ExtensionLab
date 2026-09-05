import "server-only";
import { createHash } from "node:crypto";
import { getConfig } from "@/lib/config/env";
import {
  createCheckoutRecord,
  getBillingCustomer,
  getOwnedCheckoutRecord,
  updateCheckoutStatus,
  upsertBillingCustomer,
} from "@/lib/db/repositories/billing";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import type { UserRecord } from "@/lib/db/repositories/users";
import { logger, recordMetric } from "@/lib/observability/logger";
import { formatPlanAmount, isPaidPlanId, orderedPlans } from "./plans";
import { getPlanCatalog, priceIdForPlan, toPlanView, type PlanView } from "./config";
import { getEffectivePlan, getQuotaUsage, getUsagePeriod, type EffectivePlan } from "./entitlements";
import { BillingError } from "./errors";
import { getBillingProvider, isBillingEnabled } from "./provider";
import { applyProviderSubscription } from "./subscriptions";
import type { BillingStateKind, PlanId, ProviderInvoice } from "./types";

/**
 * Application-facing billing operations. Routes call these; they never touch
 * the provider or the billing tables directly.
 */

const CHECKOUT_REUSE_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// State view (safe for the browser)

export interface BillingStateView {
  enabled: boolean;
  provider: { hostedPortal: boolean; invoices: boolean; reactivate: boolean } | null;
  plan: PlanView;
  state: BillingStateKind;
  paid: boolean;
  subscription: {
    planId: PlanId;
    status: BillingStateKind;
    currentPeriodStart: number | null;
    currentPeriodEnd: number | null;
    cancelAtPeriodEnd: boolean;
    paidUntil: number | null;
    graceUntil: number | null;
    trialEnd: number | null;
    canCancel: boolean;
    canReactivate: boolean;
  } | null;
  usage: {
    period: { start: number; end: number; source: "calendar" | "subscription" };
    analyses: { used: number; reserved: number; limit: number; remaining: number; resetAt: number };
    testRuns: { used: number; reserved: number; limit: number; remaining: number; resetAt: number };
    aiRequests: { used: number; reserved: number; limit: number; remaining: number; resetAt: number };
  };
  plans: PlanView[];
}

export function buildBillingState(userId: string, now = Date.now()): BillingStateView {
  const effective = getEffectivePlan(userId, now);
  const period = getUsagePeriod(effective, now);
  const analyses = getQuotaUsage(userId, "analysis", now);
  const testRuns = getQuotaUsage(userId, "test_run", now);
  const aiRequests = getQuotaUsage(userId, "ai_request", now);
  const catalog = getPlanCatalog();
  const enabled = isBillingEnabled();
  const capabilities = enabled ? getBillingProvider().capabilities : null;
  return {
    enabled,
    provider: capabilities ? { hostedPortal: capabilities.hostedPortal, invoices: capabilities.invoices, reactivate: capabilities.reactivate } : null,
    plan: toPlanView(effective.plan, formatPlanAmount(effective.plan)),
    state: effective.state,
    paid: effective.paid,
    subscription: describeSubscription(effective),
    usage: {
      period: { start: period.start, end: period.end, source: period.source },
      analyses: { used: analyses.used, reserved: analyses.reserved, limit: analyses.limit, remaining: analyses.remaining, resetAt: analyses.resetAt },
      testRuns: { used: testRuns.used, reserved: testRuns.reserved, limit: testRuns.limit, remaining: testRuns.remaining, resetAt: testRuns.resetAt },
      aiRequests: { used: aiRequests.used, reserved: aiRequests.reserved, limit: aiRequests.limit, remaining: aiRequests.remaining, resetAt: aiRequests.resetAt },
    },
    plans: orderedPlans(catalog).map((plan) => toPlanView(plan, formatPlanAmount(plan))),
  };
}

function describeSubscription(effective: EffectivePlan): BillingStateView["subscription"] {
  const row = effective.subscription;
  if (!row) return null;
  const live = row.status === "active" || row.status === "trialing" || row.status === "past_due";
  return {
    planId: effective.subscribedPlanId ?? "free",
    status: effective.state,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    paidUntil: effective.paidUntil,
    graceUntil: effective.graceUntil,
    trialEnd: row.trial_end,
    canCancel: live && row.cancel_at_period_end === 0,
    canReactivate: live && row.cancel_at_period_end === 1,
  };
}

// ---------------------------------------------------------------------------
// Checkout

function requireProvider() {
  if (!isBillingEnabled()) throw new BillingError("BILLING_NOT_CONFIGURED");
  return getBillingProvider();
}

async function ensureCustomer(user: UserRecord): Promise<string> {
  const provider = requireProvider();
  const existing = getBillingCustomer(user.id, provider.name);
  if (existing) return existing.provider_customer_id;
  const created = await provider.ensureCustomer({ userId: user.id, email: user.email, name: user.name });
  upsertBillingCustomer({ userId: user.id, provider: provider.name, providerCustomerId: created.customerId });
  return created.customerId;
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
  reused: boolean;
}

/**
 * Starts checkout for a paid plan. The browser only names the plan; the price
 * is resolved server-side from configuration. Repeated requests inside a
 * short window reuse the open session (and the provider idempotency key
 * guarantees one session even if the local record was lost).
 */
export async function startCheckout(user: UserRecord, requestedPlan: unknown, requestId: string): Promise<CheckoutResult> {
  const provider = requireProvider();
  if (!isPaidPlanId(requestedPlan)) throw new BillingError("INVALID_PLAN");
  const planId = requestedPlan;
  const plan = getPlanCatalog()[planId];
  const priceId = priceIdForPlan(planId);
  if (!plan.purchasable || !priceId) throw new BillingError("INVALID_PLAN", { message: "This plan is not available for purchase yet." });

  const effective = getEffectivePlan(user.id);
  if (effective.paid && effective.subscription && effective.subscribedPlanId === planId && effective.state !== "cancel_scheduled") {
    throw new BillingError("SUBSCRIPTION_STATE_INVALID", { message: "You are already subscribed to this plan." });
  }
  if (effective.paid && effective.subscription) {
    // Plan changes for an existing subscription go through the provider portal
    // (proration, payment method) rather than a second checkout.
    throw new BillingError("SUBSCRIPTION_STATE_INVALID", {
      message: "You already have an active subscription. Use Manage billing to change plans.",
    });
  }

  recordMetric("billing.checkout_attempt", 1, { plan: planId });
  const startedAt = Date.now();
  try {
    const customerId = await ensureCustomer(user);
    const appUrl = getConfig().appUrl;
    // Idempotency: the same user asking for the same plan inside a short window
    // gets the same provider session back (double clicks, retries after a
    // network error) instead of a pile of open checkouts.
    const bucket = Math.floor(Date.now() / CHECKOUT_REUSE_WINDOW_MS);
    const idempotencyKey = `checkout:${createHash("sha256").update(`${user.id}:${planId}:${bucket}`).digest("hex").slice(0, 32)}`;
    const session = await provider.createCheckoutSession({
      userId: user.id,
      planId,
      priceId,
      customerId,
      successUrl: `${appUrl}/dashboard/billing/return?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/dashboard/billing?checkout=cancelled`,
      idempotencyKey,
    });
    const reused = Boolean(getOwnedCheckoutRecord(user.id, provider.name, session.id));
    if (!reused) {
      createCheckoutRecord({ userId: user.id, provider: provider.name, providerSessionId: session.id, planId });
      recordAuditEvent({ userId: user.id, type: "checkout_started", detail: `${plan.name}` });
    }
    logger.info("billing.checkout_started", {
      component: "billing",
      requestId,
      userId: user.id,
      planId,
      provider: provider.name,
      reused,
      durationMs: Date.now() - startedAt,
      result: "ok",
    });
    return { url: session.url, sessionId: session.id, reused };
  } catch (error) {
    recordMetric("billing.checkout_failed", 1, { plan: planId });
    logger.warn("billing.checkout_failed", {
      component: "billing",
      requestId,
      userId: user.id,
      planId,
      errorCode: error instanceof BillingError ? error.code : "CHECKOUT_CREATION_FAILED",
      durationMs: Date.now() - startedAt,
      result: "error",
    });
    if (error instanceof BillingError) throw error;
    throw new BillingError("CHECKOUT_CREATION_FAILED", { cause: error });
  }
}

/**
 * Post-checkout confirmation. Called by the return page: it looks up the
 * session *we* created for this user and, if the provider reports it
 * complete, applies the provider's subscription snapshot. This is the same
 * writer the webhook uses, so arriving before the webhook is safe and arriving
 * after it is a no-op. It never marks anything paid from the URL alone.
 */
export async function confirmCheckout(user: UserRecord, sessionId: unknown): Promise<{ status: "pending" | "complete" | "expired" | "unknown" }> {
  const provider = requireProvider();
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return { status: "unknown" };
  const record = getOwnedCheckoutRecord(user.id, provider.name, sessionId);
  if (!record) return { status: "unknown" };
  const session = await provider.getCheckoutSession(sessionId);
  if (!session) return { status: record.status === "complete" ? "complete" : "unknown" };
  if (session.status === "expired") {
    updateCheckoutStatus(provider.name, sessionId, "expired");
    return { status: "expired" };
  }
  if (session.status !== "complete") return { status: "pending" };
  if (session.customerId) upsertBillingCustomer({ userId: user.id, provider: provider.name, providerCustomerId: session.customerId });
  updateCheckoutStatus(provider.name, sessionId, "complete");
  if (session.subscriptionId) {
    const subscription = await provider.getSubscription(session.subscriptionId);
    if (subscription) {
      applyProviderSubscription({ provider: provider.name, subscription, eventAt: Date.now(), userId: user.id, source: "confirm" });
    }
  }
  return { status: getEffectivePlan(user.id).paid ? "complete" : "pending" };
}

// ---------------------------------------------------------------------------
// Portal, cancel, reactivate, invoices

export async function createPortalUrl(user: UserRecord, requestId: string): Promise<string> {
  const provider = requireProvider();
  if (!provider.capabilities.hostedPortal) throw new BillingError("BILLING_NOT_CONFIGURED", { message: "Billing management is not available." });
  const customer = getBillingCustomer(user.id, provider.name);
  if (!customer) throw new BillingError("SUBSCRIPTION_NOT_FOUND", { message: "There is no billing account yet. Start with a plan upgrade." });
  const startedAt = Date.now();
  try {
    const session = await provider.createPortalSession({ customerId: customer.provider_customer_id, returnUrl: `${getConfig().appUrl}/dashboard/billing` });
    logger.info("billing.portal_opened", { component: "billing", requestId, userId: user.id, durationMs: Date.now() - startedAt, result: "ok" });
    return session.url;
  } catch (error) {
    recordMetric("billing.portal_failed", 1, { provider: provider.name });
    if (error instanceof BillingError) throw error;
    throw new BillingError("BILLING_PROVIDER_ERROR", { cause: error });
  }
}

function requireOwnedLiveSubscription(user: UserRecord) {
  const effective = getEffectivePlan(user.id);
  const row = effective.subscription;
  if (!row || !(row.status === "active" || row.status === "trialing" || row.status === "past_due")) {
    throw new BillingError("SUBSCRIPTION_NOT_FOUND");
  }
  return row;
}

/** Cancels at period end (idempotent: an already-scheduled cancellation is returned as-is). */
export async function cancelSubscription(user: UserRecord, requestId: string): Promise<BillingStateView> {
  const provider = requireProvider();
  const row = requireOwnedLiveSubscription(user);
  if (row.cancel_at_period_end === 1) return buildBillingState(user.id);
  const startedAt = Date.now();
  const updated = await provider.cancelSubscription(row.provider_subscription_id, { atPeriodEnd: provider.capabilities.cancelAtPeriodEnd });
  applyProviderSubscription({ provider: provider.name, subscription: updated, eventAt: Date.now(), userId: user.id, source: "action" });
  recordMetric("billing.cancellation", 1, { provider: provider.name, plan: row.plan_id });
  logger.info("billing.cancel_requested", { component: "billing", requestId, userId: user.id, subscriptionId: row.id, durationMs: Date.now() - startedAt, result: "ok" });
  return buildBillingState(user.id);
}

/** Reverts a scheduled cancellation on the provider (idempotent). */
export async function reactivateSubscription(user: UserRecord, requestId: string): Promise<BillingStateView> {
  const provider = requireProvider();
  if (!provider.capabilities.reactivate) throw new BillingError("SUBSCRIPTION_STATE_INVALID", { message: "Reactivation is not supported." });
  const row = requireOwnedLiveSubscription(user);
  if (row.cancel_at_period_end === 0) return buildBillingState(user.id);
  const startedAt = Date.now();
  const updated = await provider.reactivateSubscription(row.provider_subscription_id);
  applyProviderSubscription({ provider: provider.name, subscription: updated, eventAt: Date.now(), userId: user.id, source: "action" });
  recordMetric("billing.reactivation", 1, { provider: provider.name, plan: row.plan_id });
  logger.info("billing.reactivated", { component: "billing", requestId, userId: user.id, subscriptionId: row.id, durationMs: Date.now() - startedAt, result: "ok" });
  return buildBillingState(user.id);
}

export interface InvoiceView {
  id: string;
  date: number;
  amount: number;
  currency: string;
  status: ProviderInvoice["status"];
  hostedUrl: string | null;
  periodStart: number | null;
  periodEnd: number | null;
}

/** Invoices belonging to *this user's* provider customer only. */
export async function listInvoices(user: UserRecord, limit = 12): Promise<InvoiceView[]> {
  const provider = requireProvider();
  if (!provider.capabilities.invoices) return [];
  const customer = getBillingCustomer(user.id, provider.name);
  if (!customer) return [];
  const invoices = await provider.listInvoices(customer.provider_customer_id, limit);
  return invoices
    .filter((invoice) => invoice.customerId === customer.provider_customer_id && invoice.status !== "draft")
    .map((invoice) => ({
      id: invoice.id,
      date: invoice.createdAt,
      amount: invoice.status === "paid" ? invoice.amountPaid : invoice.amountDue,
      currency: invoice.currency,
      status: invoice.status,
      hostedUrl: invoice.hostedInvoiceUrl && /^https:\/\//.test(invoice.hostedInvoiceUrl) ? invoice.hostedInvoiceUrl : null,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
    }));
}

/**
 * Re-reads one subscription from the provider and applies it locally. Used by
 * operators (docs/BILLING.md → reconciliation) and by account deletion; not
 * exposed to users directly.
 */
export async function reconcileSubscription(userId: string, providerSubscriptionId: string): Promise<boolean> {
  const provider = requireProvider();
  const remote = await provider.getSubscription(providerSubscriptionId);
  if (!remote) return false;
  const applied = applyProviderSubscription({ provider: provider.name, subscription: remote, eventAt: Date.now(), userId, source: "reconcile" });
  return Boolean(applied);
}
