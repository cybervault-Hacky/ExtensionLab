import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { BillingError } from "../errors";
import type {
  BillingEventType,
  BillingProvider,
  PlanId,
  CheckoutSessionResult,
  CreateCheckoutInput,
  ProviderCheckoutSession,
  ProviderEvent,
  ProviderInvoice,
  ProviderSubscription,
  SubscriptionStatus,
} from "../types";
import { logger, recordMetric } from "@/lib/observability/logger";

/**
 * Razorpay adapter (REST API over fetch; no SDK dependency).
 *
 * Only this file knows Razorpay's endpoints, request encoding and event
 * vocabulary. Everything is normalized into the provider-agnostic types from
 * `lib/billing/types` before it leaves this module; raw provider errors,
 * payloads and credentials never escape. Failures become safe BillingErrors
 * and only the failure *class* is logged.
 *
 * Model mapping:
 * - Customer      → Razorpay Customer            (ensureCustomer)
 * - Subscription  → Razorpay Subscription on a   (createCheckoutSession
 *                   configured Razorpay Plan        creates the subscription;
 *                   (RAZORPAY_PLAN_ID_*)             the browser then opens
 *                                                   Razorpay Standard Checkout
 *                                                   with the public key id)
 * - "Checkout"    → the subscription itself      (getCheckoutSession reads
 *                                                   its state; created ⇒ open,
 *                                                   authenticated/active ⇒
 *                                                   complete)
 * - Webhook       → x-razorpay-signature =       (verifyWebhook)
 *                   HMAC-SHA256(rawBody, webhook
 *                   secret)
 *
 * Money: Razorpay amounts are integer paise (smallest currency unit). No
 * floating-point arithmetic is performed on monetary values anywhere.
 */

const API_BASE = "https://api.razorpay.com/v1";

export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Plan amounts fetched once per plan id and cached (price-change guard §87). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asEpochMs(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && n > 0 ? Math.round(n * 1000) : null; // Razorpay epochs are seconds
}

/** Razorpay subscription → normalized ProviderSubscription. */
export function normalizeRazorpaySubscription(body: Json): ProviderSubscription | null {
  const id = asString(body.id);
  if (!id) return null;
  const status = mapSubscriptionStatus(asString(body.status));
  // current_start/current_end are the ACTIVE charge cycle; start/end are the
  // subscription's overall bounds. The current cycle drives entitlements.
  const currentPeriodStart = asEpochMs(body.current_start) ?? asEpochMs(body.start);
  const endedAt = asEpochMs(body.end);
  const currentPeriodEnd = asEpochMs(body.current_end) ?? endedAt;
  return {
    id,
    customerId: asString(body.customer_id) ?? "",
    status,
    priceId: asString(body.plan_id),
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: false, // Razorpay has no scheduled-cancel state; cancel is immediate on API call
    cancelAt: null,
    canceledAt: asEpochMs(body.canceled_at) ?? (status === "canceled" ? asEpochMs(body.ended_at) : null),
    trialEnd: null,
    endedAt,
    metadata: {
      userId: asString(asRecord(body.notes)?.userId) ?? undefined,
      planId: asString(asRecord(body.notes)?.planId) ?? undefined,
    },
  };
}

/**
 * Razorpay subscription states → normalized statuses.
 *   created            → incomplete  (checkout opened, no payment yet)
 *   authenticated      → active      (mandate approved + first charge authorized)
 *   active             → active
 *   pending            → past_due    (charge failed; Razorpay retries)
 *   halted             → unpaid      (retries exhausted)
 *   cancelled          → canceled
 *   completed          → active while the paid-for cycle remains, else canceled
 *   expired            → incomplete_expired
 */
export function mapSubscriptionStatus(status: string | null): SubscriptionStatus {
  switch (status) {
    case "authenticated":
    case "active":
      return "active";
    case "pending":
      return "past_due";
    case "halted":
      return "unpaid";
    case "cancelled":
      return "canceled";
    case "completed": {
      // Caller refines with dates when available; without dates treat as ended.
      return "active";
    }
    case "expired":
      return "incomplete_expired";
    case "created":
    default:
      return "incomplete";
  }
}

function refineCompleted(sub: ProviderSubscription, raw: Json): ProviderSubscription {
  if (sub.status !== "active") return sub;
  const rawStatus = asString(raw.status);
  if (rawStatus !== "completed") return sub;
  const end = asEpochMs(raw.end) ?? asEpochMs(raw.current_end);
  if (end !== null && end <= Date.now()) {
    return { ...sub, status: "canceled", endedAt: end, currentPeriodEnd: end };
  }
  return sub;
}

export function createRazorpayProvider(options: RazorpayOptions): BillingProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const planCache = new Map<string, { amount: number; currency: string }>();

  function authHeader(): string {
    // Basic auth with the key pair; the header value itself is never logged.
    return `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`;
  }

  async function call(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<Json> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const url = method === "GET" && params && Object.keys(params).length > 0 ? `${API_BASE}${path}?${new URLSearchParams(clean(params))}` : `${API_BASE}${path}`;
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: authHeader(),
          ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: method === "POST" ? new URLSearchParams(params ? clean(params) : {}).toString() : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let body: Json = {};
      try {
        body = asRecord(JSON.parse(text)) ?? {};
      } catch {
        body = {};
      }
      if (!response.ok) {
        const error = asRecord(body.error);
        // Log the Razorpay error *code* only; messages can echo request data.
        logger.warn("billing.provider_error", {
          component: "billing",
          provider: "razorpay",
          path,
          status: response.status,
          errorType: asString(error?.code) ?? "unknown",
          errorCode: "BILLING_PROVIDER_ERROR",
          durationMs: Date.now() - startedAt,
        });
        recordMetric("billing.provider_error", 1, { provider: "razorpay", status: String(response.status) });
        // 4xx (except 429) are permanent for this request; 5xx/429/timeout are
        // "provider unavailable" so callers can surface a retryable error.
        if (response.status === 429 || response.status >= 500) {
          throw new BillingError("BILLING_PROVIDER_UNAVAILABLE", { retryable: true });
        }
        throw new BillingError("BILLING_PROVIDER_ERROR", { retryable: false });
      }
      return body;
    } catch (error) {
      if (error instanceof BillingError) throw error;
      logger.warn("billing.provider_unreachable", {
        component: "billing",
        provider: "razorpay",
        path,
        errorCode: "BILLING_PROVIDER_UNAVAILABLE",
        durationMs: Date.now() - startedAt,
      });
      recordMetric("billing.provider_error", 1, { provider: "razorpay", status: "network" });
      throw new BillingError("BILLING_PROVIDER_UNAVAILABLE", { retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  function clean(params: Record<string, string | number | undefined> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) out[key] = String(value);
    }
    return out;
  }

  /**
   * Price-change guard (§87): reads the Razorpay plan's item amount/currency
   * and compares it with the catalog amount supplied by the server. Any
   * mismatch fails closed before a subscription is created.
   */
  async function verifiedPlanAmount(planId: string, expectedAmount: number | null | undefined, expectedCurrency: string | undefined): Promise<{ amount: number; currency: string }> {
    const cached = planCache.get(planId);
    let resolved = cached;
    if (!resolved) {
      const body = await call("GET", `/plans/${encodeURIComponent(planId)}`);
      const item = asRecord(body.item);
      const amount = asNumber(item?.amount);
      const currency = asString(item?.currency)?.toLowerCase() ?? null;
      if (amount === null || !currency) {
        throw new BillingError("BILLING_CONFIGURATION_ERROR", { message: "The Razorpay plan could not be read." });
      }
      resolved = { amount, currency };
      planCache.set(planId, resolved);
    }
    if (expectedAmount !== undefined && expectedAmount !== null && resolved.amount !== expectedAmount) {
      logger.error("billing.plan_price_mismatch", {
        component: "billing",
        provider: "razorpay",
        planId,
        expectedAmount, // catalog value; safe
        errorCode: "PAYMENT_MISMATCH",
      });
      throw new BillingError("PAYMENT_MISMATCH", { message: "The plan price has changed. Please refresh and try again." });
    }
    if (expectedCurrency && resolved.currency !== expectedCurrency.toLowerCase()) {
      throw new BillingError("PAYMENT_MISMATCH", { message: "The plan currency does not match the catalog." });
    }
    return resolved;
  }

  return {
    name: "razorpay",
    // Razorpay has no hosted billing portal in the Stripe sense; management
    // happens through ExtensionLab's own billing page. Scheduled-cancel +
    // resume are not exposed by Razorpay's subscription API (cancel is
    // immediate or at cycle end; resuming a scheduled cancel is unsupported).
    capabilities: { hostedPortal: false, cancelAtPeriodEnd: true, reactivate: false, invoices: true },

    async ensureCustomer(input) {
      const body = await call("POST", "/customers", {
        name: input.name || input.email.split("@")[0] || "ExtensionLab user",
        email: input.email,
        "notes[userId]": input.userId,
      });
      const id = asString(body.id);
      if (!id) throw new BillingError("BILLING_PROVIDER_ERROR");
      return { customerId: id };
    },

    async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSessionResult> {
      const plan = await verifiedPlanAmount(input.priceId, input.expectedAmount, input.expectedCurrency);
      // Subscriptions charge the Razorpay plan directly; the browser never
      // sees or chooses an amount. total_count omitted ⇒ runs until cancelled.
      const body = await call("POST", "/subscriptions", {
        plan_id: input.priceId,
        customer_id: input.customerId,
        total_count: 0,
        quantity: 1,
        customer_notify: 0,
        "notes[userId]": input.userId,
        "notes[planId]": input.planId,
      });
      const id = asString(body.id);
      const status = asString(body.status);
      if (!id || !status) throw new BillingError("CHECKOUT_CREATION_FAILED");
      void plan;
      return {
        id,
        // The app's return page: Razorpay Checkout is opened client-side with
        // the safe public config below, then lands here to confirm.
        url: input.successUrl.replace("{CHECKOUT_SESSION_ID}", id),
        checkout: {
          provider: "razorpay",
          keyId: options.keyId, // public by design (Razorpay Standard Checkout)
          subscriptionId: id,
          planName: input.planId,
          currency: plan.currency,
          amount: plan.amount,
        },
      };
    },

    async rebuildCheckoutSession(input: { sessionId: string; planId: PlanId; priceId: string; successUrl: string }): Promise<CheckoutSessionResult | undefined> {
      // Reuse only a subscription that still exists at the provider; verify
      // the plan price again (it may have changed since the first click).
      const plan = await verifiedPlanAmount(input.priceId, undefined, undefined);
      const body = await call("GET", `/subscriptions/${encodeURIComponent(input.sessionId)}`);
      const existing = normalizeRazorpaySubscription(body);
      if (!existing) return undefined;
      return {
        id: input.sessionId,
        url: input.successUrl.replace("{CHECKOUT_SESSION_ID}", input.sessionId),
        checkout: {
          provider: "razorpay",
          keyId: options.keyId,
          subscriptionId: input.sessionId,
          planName: input.planId,
          currency: plan.currency,
          amount: plan.amount,
        },
      };
    },

    async createPortalSession() {
      // Capability is reported as false; reaching here is a programming error.
      throw new BillingError("BILLING_NOT_CONFIGURED", { message: "Billing management is not available." });
    },

    async getCheckoutSession(subscriptionId): Promise<ProviderCheckoutSession | null> {
      let body: Json;
      try {
        body = await call("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      } catch (error) {
        if (error instanceof BillingError && !error.retryable) return null;
        throw error;
      }
      const sub = normalizeRazorpaySubscription(body);
      if (!sub) return null;
      // "complete" only once the provider moved the subscription past
      // checkout (authenticated/active). A `created` subscription is still an
      // open checkout; pending/halted await/failed payment; cancelled/expired
      // is closed.
      const rawStatus = asString(body.status);
      const isOpen = rawStatus === "created" || rawStatus === "pending" || rawStatus === "halted";
      const status: ProviderCheckoutSession["status"] = sub.status === "active" ? "complete" : isOpen ? "open" : "expired";
      return {
        id: subscriptionId,
        customerId: sub.customerId || null,
        subscriptionId: sub.id,
        status,
        metadata: sub.metadata,
      };
    },

    async getSubscription(subscriptionId) {
      try {
        const body = await call("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
        const sub = normalizeRazorpaySubscription(body);
        return sub ? refineCompleted(sub, body) : null;
      } catch (error) {
        if (error instanceof BillingError && !error.retryable) return null;
        throw error;
      }
    },

    async cancelSubscription(subscriptionId, opts) {
      // cancel_at_cycle_end=1 keeps access until the cycle ends; immediate
      // otherwise. Razorpay returns the updated subscription either way.
      const body = await call("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        cancel_at_cycle_end: opts.atPeriodEnd ? 1 : 0,
      });
      const sub = normalizeRazorpaySubscription(body);
      if (!sub) throw new BillingError("BILLING_PROVIDER_ERROR");
      // Razorpay reports scheduled cancels only through end dates; model it
      // explicitly so entitlements keep the paid window (§41).
      if (opts.atPeriodEnd && sub.status === "active" && sub.currentPeriodEnd) {
        return { ...sub, cancelAtPeriodEnd: true, cancelAt: sub.currentPeriodEnd };
      }
      return sub;
    },

    async reactivateSubscription() {
      // Capability is reported as false (Razorpay has no resume-scheduled-cancel).
      throw new BillingError("SUBSCRIPTION_STATE_INVALID", { message: "Reactivation is not supported." });
    },

    async listInvoices(customerId, limit) {
      const body = await call("GET", "/invoices", {
        customer_id: customerId,
        count: Math.min(Math.max(limit, 1), 100),
      });
      const items = Array.isArray(body.items) ? (body.items as unknown[]) : [];
      return items
        .map((item) => asRecord(item))
        .filter((item): item is Json => item !== null)
        .map((item) => {
          const invoice: ProviderInvoice = {
            id: asString(item.id) ?? "",
            customerId: asString(item.customer_id) ?? customerId,
            subscriptionId: asString(item.subscription_id),
            status: mapInvoiceStatus(asString(item.status)),
            amountDue: asNumber(asRecord(item.amount)?.due) ?? 0,
            amountPaid: asNumber(asRecord(item.amount)?.paid) ?? 0,
            currency: (asString(asRecord(item.amount)?.currency) ?? "inr").toLowerCase(),
            hostedInvoiceUrl: asString(item.short_url),
            periodStart: asEpochMs(asRecord(item.period)?.start),
            periodEnd: asEpochMs(asRecord(item.period)?.end),
            createdAt: asEpochMs(item.created_at) ?? Date.now(),
          };
          return invoice;
        })
        .filter((invoice) => invoice.id !== "");
    },

    verifyCheckoutConfirmation(input) {
      // Razorpay checkout handler signature: HMAC-SHA256(keySecret,
      // `${razorpay_payment_id}|${razorpay_order_id}`) for order flow or
      // `${razorpay_payment_id}|${razorpay_subscription_id}` for subscriptions.
      const subject = input.orderId
        ? `${input.paymentId}|${input.orderId}`
        : input.subscriptionId
          ? `${input.paymentId}|${input.subscriptionId}`
          : null;
      if (!subject || !/^[0-9a-f]{64}$/i.test(input.signature)) return false;
      const expected = createHmac("sha256", options.keySecret).update(subject, "utf8").digest();
      const actual = Buffer.from(input.signature.toLowerCase(), "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },

    verifyWebhook(rawBody, headers) {
      const signature = headers.get("x-razorpay-signature");
      if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) {
        recordMetric("billing.webhook_rejected", 1, { provider: "razorpay", reason: signature ? "malformed" : "missing" });
        throw new BillingError("WEBHOOK_SIGNATURE_INVALID");
      }
      const expected = createHmac("sha256", options.webhookSecret).update(rawBody, "utf8").digest("hex");
      const expectedBuf = Buffer.from(expected, "hex");
      const actualBuf = Buffer.from(signature.toLowerCase(), "hex");
      if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
        recordMetric("billing.webhook_rejected", 1, { provider: "razorpay", reason: "mismatch" });
        throw new BillingError("WEBHOOK_SIGNATURE_INVALID");
      }
      let parsed: Json | null;
      try {
        parsed = asRecord(JSON.parse(rawBody));
      } catch {
        parsed = null;
      }
      if (!parsed) throw new BillingError("WEBHOOK_SIGNATURE_INVALID", { message: "The webhook payload is malformed." });
      return normalizeRazorpayEvent(parsed);
    },
  };
}

function mapInvoiceStatus(status: string | null): ProviderInvoice["status"] {
  switch (status) {
    case "paid":
      return "paid";
    case "cancelled":
      return "void";
    case "issued":
    case "partially_paid":
      return "open";
    case "bad_debt":
      return "uncollectible";
    default:
      return "draft";
  }
}

/**
 * Razorpay webhook events → internal billing events. Event names are
 * Razorpay's documented webhook identifiers; nothing is invented here.
 */
export function normalizeRazorpayEvent(payload: Json): ProviderEvent {
  const event = asString(payload.event) ?? "unknown";
  const createdAt = asEpochMs(payload.created_at) ?? Date.now();
  const id = asString(payload.event_id ?? payload.id) ?? `${event}:${createdAt}:${Math.random().toString(36).slice(2)}`;

  const payloadEnvelope: Json = asRecord(payload.payload) ?? {};
  const subscriptionEntity = asRecord(asRecord(payloadEnvelope.subscription)?.entity);
  const subscriptionPayload = subscriptionEntity ?? (event.startsWith("subscription.") ? payloadEnvelope : null);
  const paymentPayload = asRecord(asRecord(payloadEnvelope.payment)?.entity);
  const invoicePayload = asRecord(asRecord(payloadEnvelope.invoice)?.entity);

  const rawSubscription = subscriptionPayload ? normalizeRazorpaySubscription(subscriptionPayload) : null;
  const subscription = rawSubscription ? refineCompleted(rawSubscription, subscriptionPayload!) : undefined;

  let type: BillingEventType = "unknown";
  switch (event) {
    case "payment.captured":
      type = "invoice.paid"; // payment recorded; subscription snapshot (if any) drives activation
      break;
    case "payment.failed":
      type = "invoice.payment_failed";
      break;
    case "subscription.authenticated":
    case "subscription.activated":
      type = "subscription.updated"; // becomes active via the snapshot
      break;
    case "subscription.charged":
      type = "invoice.paid"; // renewal charge; snapshot carries the new cycle
      break;
    case "subscription.pending":
      type = "subscription.updated"; // charge retrying → past_due snapshot
      break;
    case "subscription.halted":
      type = "subscription.updated"; // retries exhausted → unpaid snapshot
      break;
    case "subscription.cancelled":
      type = "subscription.deleted";
      break;
    case "subscription.completed":
      type = "subscription.updated"; // all cycles done; refineCompleted may end it
      break;
    default:
      type = "unknown";
      break;
  }

  const invoice: ProviderInvoice | undefined = invoicePayload
    ? {
        id: asString(invoicePayload.id) ?? "",
        customerId: asString(invoicePayload.customer_id) ?? "",
        subscriptionId: asString(invoicePayload.subscription_id) ?? subscription?.id ?? null,
        status: mapInvoiceStatus(asString(invoicePayload.status)),
        amountDue: asNumber(asRecord(invoicePayload.amount)?.due) ?? asNumber(invoicePayload.amount) ?? 0,
        amountPaid: asNumber(asRecord(invoicePayload.amount)?.paid) ?? 0,
        currency: (asString(asRecord(invoicePayload.amount)?.currency) ?? "inr").toLowerCase(),
        hostedInvoiceUrl: asString(invoicePayload.short_url),
        periodStart: asEpochMs(asRecord(invoicePayload.period)?.start),
        periodEnd: asEpochMs(asRecord(invoicePayload.period)?.end),
        createdAt: asEpochMs(invoicePayload.created_at) ?? createdAt,
      }
    : paymentPayload
      ? {
          // subscription.charged / payment.captured carry a payment entity;
          // surface it as a normalized invoice so the ledger records money.
          id: asString(paymentPayload.invoice_id) ?? asString(paymentPayload.id) ?? "",
          customerId: asString(paymentPayload.customer_id) ?? "",
          subscriptionId: asString(paymentPayload.subscription_id) ?? subscription?.id ?? null,
          status: event === "payment.failed" ? "open" : "paid",
          amountDue: asNumber(paymentPayload.amount) ?? 0,
          amountPaid: event === "payment.failed" ? 0 : (asNumber(paymentPayload.amount) ?? 0),
          currency: (asString(paymentPayload.currency) ?? "inr").toLowerCase(),
          hostedInvoiceUrl: null,
          periodStart: null,
          periodEnd: null,
          createdAt: asEpochMs(paymentPayload.created_at) ?? createdAt,
        }
    : undefined;

  return {
    id,
    type,
    providerType: event,
    createdAt,
    subscription,
    invoice: invoice && invoice.id !== "" ? invoice : undefined,
    customerId: subscription?.customerId ?? asString(paymentPayload?.customer_id) ?? asString(invoicePayload?.customer_id) ?? undefined,
  };
}
