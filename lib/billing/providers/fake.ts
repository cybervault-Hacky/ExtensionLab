import { randomBytes } from "node:crypto";
import { BillingError } from "../errors";
import type {
  BillingProvider,
  CheckoutSessionResult,
  CreateCheckoutInput,
  ProviderCheckoutSession,
  ProviderInvoice,
  ProviderSubscription,
  SubscriptionStatus,
} from "../types";
import { signPayload, verifySignature } from "./signature";
// The fake provider emits Stripe-shaped events so one normalizer serves both.
import { normalizeStripeEvent } from "./stripe-normalize";

/**
 * FakeBillingProvider — development and test only.
 *
 * It keeps customers, subscriptions and invoices in memory and exposes the
 * same interface as the Stripe adapter. It never grants anything by itself:
 * a fake "payment" only becomes a local subscription when a *signed* webhook
 * built with `buildWebhookDelivery()` is posted to the real webhook route,
 * so tests and the local smoke flow exercise the production activation path.
 *
 * Selecting it in production is rejected by configuration validation.
 */

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

interface FakeCustomer {
  id: string;
  userId: string;
  email: string;
}

interface FakeSubscription extends ProviderSubscription {
  planId: string;
}

interface FakeCheckout extends ProviderCheckoutSession {
  planId: string;
  priceId: string;
  userId: string;
  url: string;
  idempotencyKey: string;
}

export interface FakeProviderOptions {
  webhookSecret: string;
  /** Maps plan ids to the "price ids" the app configured (used to build subscriptions). */
  now?: () => number;
}

export interface FakeWebhookDelivery {
  body: string;
  headers: Record<string, string>;
  event: Record<string, unknown>;
}

export interface FakeBillingProvider extends BillingProvider {
  readonly name: "fake";
  /** Test helpers (never used by application code). */
  readonly fake: {
    customers: Map<string, FakeCustomer>;
    subscriptions: Map<string, FakeSubscription>;
    checkouts: Map<string, FakeCheckout>;
    invoices: Map<string, ProviderInvoice[]>;
    /** Simulates the customer paying: creates a subscription and returns the checkout event. */
    completeCheckout(sessionId: string, options?: { trialDays?: number }): { subscription: FakeSubscription; events: FakeWebhookDelivery[] };
    /** Applies a status/period change and returns the matching webhook delivery. */
    updateSubscription(subscriptionId: string, patch: Partial<Pick<FakeSubscription, "status" | "currentPeriodStart" | "currentPeriodEnd" | "cancelAtPeriodEnd" | "cancelAt" | "canceledAt" | "endedAt" | "priceId">> & { planId?: string }): FakeWebhookDelivery;
    /** Simulates a renewal invoice (paid or failed). */
    invoice(subscriptionId: string, outcome: "paid" | "failed", amount?: number): FakeWebhookDelivery;
    /** Simulates the period ending after a scheduled cancellation. */
    expire(subscriptionId: string): FakeWebhookDelivery;
    /** Builds a signed delivery for an arbitrary (Stripe-shaped) event object. */
    sign(event: Record<string, unknown>, options?: { timestamp?: number; secret?: string }): FakeWebhookDelivery;
    /** Failure injection for the next N API calls. */
    failNext(count: number): void;
    reset(): void;
  };
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function createFakeProvider(options: FakeProviderOptions): FakeBillingProvider {
  const now = options.now ?? (() => Date.now());
  const customers = new Map<string, FakeCustomer>();
  const subscriptions = new Map<string, FakeSubscription>();
  const checkouts = new Map<string, FakeCheckout>();
  const invoices = new Map<string, ProviderInvoice[]>();
  let failuresLeft = 0;
  let eventCounter = 0;

  function maybeFail(): void {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new BillingError("BILLING_PROVIDER_ERROR", { retryable: true });
    }
  }

  function subscriptionObject(sub: FakeSubscription): Record<string, unknown> {
    const toSeconds = (value: number | null) => (value === null ? null : Math.floor(value / 1000));
    return {
      id: sub.id,
      object: "subscription",
      customer: sub.customerId,
      status: sub.status,
      cancel_at_period_end: sub.cancelAtPeriodEnd,
      cancel_at: toSeconds(sub.cancelAt),
      canceled_at: toSeconds(sub.canceledAt),
      trial_end: toSeconds(sub.trialEnd),
      ended_at: toSeconds(sub.endedAt),
      current_period_start: toSeconds(sub.currentPeriodStart),
      current_period_end: toSeconds(sub.currentPeriodEnd),
      items: { object: "list", data: [{ id: id("si"), object: "subscription_item", price: { id: sub.priceId, object: "price" } }] },
      metadata: { userId: sub.metadata.userId, planId: sub.metadata.planId },
    };
  }

  function invoiceObject(inv: ProviderInvoice): Record<string, unknown> {
    return {
      id: inv.id,
      object: "invoice",
      customer: inv.customerId,
      subscription: inv.subscriptionId,
      status: inv.status,
      amount_due: inv.amountDue,
      amount_paid: inv.amountPaid,
      currency: inv.currency,
      hosted_invoice_url: inv.hostedInvoiceUrl,
      period_start: inv.periodStart === null ? null : Math.floor(inv.periodStart / 1000),
      period_end: inv.periodEnd === null ? null : Math.floor(inv.periodEnd / 1000),
      created: Math.floor(inv.createdAt / 1000),
    };
  }

  function sign(event: Record<string, unknown>, signOptions: { timestamp?: number; secret?: string } = {}): FakeWebhookDelivery {
    const body = JSON.stringify(event);
    const timestamp = signOptions.timestamp ?? Math.floor(now() / 1000);
    return {
      body,
      headers: { "stripe-signature": signPayload(signOptions.secret ?? options.webhookSecret, body, timestamp), "content-type": "application/json" },
      event,
    };
  }

  function makeEvent(type: string, object: Record<string, unknown>): FakeWebhookDelivery {
    eventCounter += 1;
    const event = {
      id: `evt_fake_${eventCounter.toString(36)}_${randomBytes(4).toString("hex")}`,
      object: "event",
      type,
      created: Math.floor(now() / 1000),
      data: { object },
    };
    return sign(event);
  }

  function requireSubscription(subscriptionId: string): FakeSubscription {
    const sub = subscriptions.get(subscriptionId);
    if (!sub) throw new BillingError("SUBSCRIPTION_NOT_FOUND");
    return sub;
  }

  const provider: FakeBillingProvider = {
    name: "fake",
    capabilities: { hostedPortal: true, cancelAtPeriodEnd: true, reactivate: true, invoices: true },

    async ensureCustomer(input) {
      maybeFail();
      for (const customer of customers.values()) {
        if (customer.userId === input.userId) return { customerId: customer.id };
      }
      const customer: FakeCustomer = { id: id("cus_fake"), userId: input.userId, email: input.email };
      customers.set(customer.id, customer);
      return { customerId: customer.id };
    },

    async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSessionResult> {
      maybeFail();
      for (const existing of checkouts.values()) {
        if (existing.userId === input.userId && existing.planId === input.planId && existing.status === "open" && existing.idempotencyKey === input.idempotencyKey) {
          return { id: existing.id, url: existing.url };
        }
      }
      const session: FakeCheckout = {
        id: id("cs_fake"),
        customerId: input.customerId,
        subscriptionId: null,
        status: "open",
        metadata: { userId: input.userId, planId: input.planId },
        planId: input.planId,
        priceId: input.priceId,
        userId: input.userId,
        url: "",
        idempotencyKey: input.idempotencyKey,
      };
      // The success URL is the app's own return page; the fake checkout "page"
      // is that URL with the session id, mirroring Stripe's {CHECKOUT_SESSION_ID}.
      session.url = input.successUrl.replace("{CHECKOUT_SESSION_ID}", session.id);
      checkouts.set(session.id, session);
      return { id: session.id, url: session.url };
    },

    async createPortalSession(input) {
      maybeFail();
      return { url: `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}portal=fake` };
    },

    async getCheckoutSession(sessionId) {
      maybeFail();
      const session = checkouts.get(sessionId);
      if (!session) return null;
      return { id: session.id, customerId: session.customerId, subscriptionId: session.subscriptionId, status: session.status, metadata: session.metadata };
    },

    async getSubscription(subscriptionId) {
      maybeFail();
      return subscriptions.get(subscriptionId) ?? null;
    },

    async cancelSubscription(subscriptionId, opts) {
      maybeFail();
      const sub = requireSubscription(subscriptionId);
      if (opts.atPeriodEnd) {
        sub.cancelAtPeriodEnd = true;
        sub.cancelAt = sub.currentPeriodEnd;
        sub.canceledAt = now();
      } else {
        sub.status = "canceled";
        sub.canceledAt = now();
        sub.endedAt = now();
        sub.cancelAtPeriodEnd = false;
      }
      return { ...sub };
    },

    async reactivateSubscription(subscriptionId) {
      maybeFail();
      const sub = requireSubscription(subscriptionId);
      if (sub.status === "canceled") throw new BillingError("SUBSCRIPTION_STATE_INVALID");
      sub.cancelAtPeriodEnd = false;
      sub.cancelAt = null;
      sub.canceledAt = null;
      return { ...sub };
    },

    async listInvoices(customerId, limit) {
      maybeFail();
      return (invoices.get(customerId) ?? []).slice(0, limit);
    },

    verifyWebhook(rawBody, headers) {
      const result = verifySignature({ secret: options.webhookSecret, rawBody, header: headers.get("stripe-signature"), nowSeconds: Math.floor(now() / 1000) });
      if (!result.ok) throw new BillingError("WEBHOOK_SIGNATURE_INVALID");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new BillingError("WEBHOOK_SIGNATURE_INVALID", { message: "The webhook payload is malformed." });
      }
      // Reuse the Stripe normalizer so both providers produce identical events.
      return normalizeStripeEvent(parsed);
    },

    fake: {
      customers,
      subscriptions,
      checkouts,
      invoices,
      completeCheckout(sessionId, completeOptions = {}) {
        const session = checkouts.get(sessionId);
        if (!session || session.status !== "open") throw new Error("fake checkout session not open");
        const start = now();
        const trialDays = completeOptions.trialDays ?? 0;
        const sub: FakeSubscription = {
          id: id("sub_fake"),
          customerId: session.customerId ?? "",
          status: trialDays > 0 ? "trialing" : "active",
          priceId: session.priceId,
          currentPeriodStart: start,
          currentPeriodEnd: start + (trialDays > 0 ? trialDays * 24 * 60 * 60 * 1000 : MONTH_MS),
          cancelAtPeriodEnd: false,
          cancelAt: null,
          canceledAt: null,
          trialEnd: trialDays > 0 ? start + trialDays * 24 * 60 * 60 * 1000 : null,
          endedAt: null,
          metadata: { userId: session.userId, planId: session.planId },
          planId: session.planId,
        };
        subscriptions.set(sub.id, sub);
        session.status = "complete";
        session.subscriptionId = sub.id;
        const events = [
          makeEvent("customer.subscription.created", subscriptionObject(sub)),
          makeEvent("checkout.session.completed", {
            id: session.id,
            object: "checkout.session",
            customer: session.customerId,
            subscription: sub.id,
            status: "complete",
            mode: "subscription",
            metadata: session.metadata,
          }),
        ];
        if (trialDays === 0) events.push(provider.fake.invoice(sub.id, "paid"));
        return { subscription: sub, events };
      },
      updateSubscription(subscriptionId, patch) {
        const sub = requireSubscription(subscriptionId);
        const { planId, ...rest } = patch;
        Object.assign(sub, rest);
        if (planId) {
          sub.planId = planId;
          sub.metadata = { ...sub.metadata, planId };
        }
        return makeEvent("customer.subscription.updated", subscriptionObject(sub));
      },
      invoice(subscriptionId, outcome, amount = 0) {
        const sub = requireSubscription(subscriptionId);
        const inv: ProviderInvoice = {
          id: id("in_fake"),
          customerId: sub.customerId,
          subscriptionId: sub.id,
          status: outcome === "paid" ? "paid" : "open",
          amountDue: amount,
          amountPaid: outcome === "paid" ? amount : 0,
          currency: "inr",
          hostedInvoiceUrl: `https://invoices.example.invalid/${sub.id}/${eventCounter + 1}`,
          periodStart: sub.currentPeriodStart,
          periodEnd: sub.currentPeriodEnd,
          createdAt: now(),
        };
        const list = invoices.get(sub.customerId) ?? [];
        list.unshift(inv);
        invoices.set(sub.customerId, list);
        if (outcome === "failed") sub.status = "past_due" as SubscriptionStatus;
        return makeEvent(outcome === "paid" ? "invoice.paid" : "invoice.payment_failed", invoiceObject(inv));
      },
      expire(subscriptionId) {
        const sub = requireSubscription(subscriptionId);
        sub.status = "canceled";
        sub.endedAt = sub.currentPeriodEnd ?? now();
        sub.canceledAt = sub.canceledAt ?? now();
        return makeEvent("customer.subscription.deleted", subscriptionObject(sub));
      },
      sign,
      failNext(count) {
        failuresLeft = count;
      },
      reset() {
        customers.clear();
        subscriptions.clear();
        checkouts.clear();
        invoices.clear();
        failuresLeft = 0;
      },
    },
  };
  return provider;
}

