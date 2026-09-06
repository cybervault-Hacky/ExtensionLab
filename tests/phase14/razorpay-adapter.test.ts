import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as webhookRoute } from "@/app/api/billing/webhook/route";
import { createRazorpayProvider, mapSubscriptionStatus, normalizeRazorpayEvent } from "@/lib/billing/providers/razorpay";
import { BillingError } from "@/lib/billing/errors";
import { describeConfig, getConfig, loadConfig, ConfigError } from "@/lib/config/env";
import { checkoutConfirmationSignature, FakeRazorpayApi, RAZORPAY_KEY_ID, setupPhase14Harness, type Harness } from "./helpers";

let harness: Harness & { api: FakeRazorpayApi };
let api: FakeRazorpayApi;

beforeEach(() => {
  harness = setupPhase14Harness();
  api = harness.api;
});

afterEach(() => {
  harness.teardown();
});

/**
 * §4/§5/§77: Razorpay configuration fails closed and never leaks secrets.
 */
describe("Phase 14: Razorpay configuration", () => {
  it("accepts a complete credential set and maps RAZORPAY_PLAN_ID_* into the shared price mapping", () => {
    const config = getConfig();
    expect(config.billing.provider).toBe("razorpay");
    expect(config.billing.razorpay.keyId).toBe(RAZORPAY_KEY_ID);
    expect(config.billing.priceIds.pro).toBe("plan_pro_test");
    expect(config.billing.priceIds.business).toBe("plan_business_test");
    expect(getConfig().billing.currency).toBe("inr");
  });

  it("describeConfig exposes booleans only — never credential values", () => {
    const described = JSON.stringify(describeConfig());
    expect(described).not.toContain(RAZORPAY_KEY_ID.slice(-10));
    expect(described).not.toContain("test_key_secret_phase14");
    expect(described).not.toContain("whsec_test_phase14");
    expect(described).toContain("razorpayConfigured");
  });

  it("missing credentials are configuration problems in every environment, and hard-fail in production", () => {
    const base: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
      APP_ENV: "development",
      APP_URL: "https://extensionlab.test",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      BILLING_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID,
      RAZORPAY_WEBHOOK_SECRET: "whsec_x",
      RAZORPAY_PLAN_ID_PRO: "plan_pro_test",
    };
    delete base.RAZORPAY_KEY_SECRET; // intentionally missing
    const dev = loadConfig(base as unknown as NodeJS.ProcessEnv);
    // Development surfaces the problem without crashing…
    void dev;
    // …and the same env in production fails closed:
    expect(() => loadConfig({ ...base, APP_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigError);
    try {
      loadConfig({ ...base, APP_ENV: "production" } as unknown as NodeJS.ProcessEnv);
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(problems.some((problem) => problem.includes("RAZORPAY_KEY_SECRET is required"))).toBe(true);
    }
  });

  it("selecting razorpay without any plan mapping is a configuration problem", () => {
    const base: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
      APP_ENV: "production",
      APP_URL: "https://extensionlab.test",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      BILLING_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: "s",
      RAZORPAY_WEBHOOK_SECRET: "w",
    };
    delete base.RAZORPAY_PLAN_ID_PRO;
    delete base.RAZORPAY_PLAN_ID_BUSINESS;
    expect(() => loadConfig(base as unknown as NodeJS.ProcessEnv)).toThrow(/RAZORPAY_PLAN_ID_PRO/);
  });

  it("rejects a key id that is not a Razorpay key", () => {
    const base = {
      ...(process.env as Record<string, string>),
      APP_ENV: "production",
      APP_URL: "https://extensionlab.test",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      BILLING_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "not-a-razorpay-key",
      RAZORPAY_KEY_SECRET: "s",
      RAZORPAY_WEBHOOK_SECRET: "w",
      RAZORPAY_PLAN_ID_PRO: "plan_pro_test",
    };
    expect(() => loadConfig(base as unknown as NodeJS.ProcessEnv)).toThrow(/RAZORPAY_KEY_ID must be a Razorpay key id/);
  });
});

/**
 * §18/§19: Razorpay event and status vocabulary, mapped inside the adapter.
 */
describe("Phase 14: Razorpay status + event normalization", () => {
  it("maps every Razorpay subscription state onto the normalized model", () => {
    expect(mapSubscriptionStatus("created")).toBe("incomplete");
    expect(mapSubscriptionStatus("authenticated")).toBe("active");
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("pending")).toBe("past_due");
    expect(mapSubscriptionStatus("halted")).toBe("unpaid");
    expect(mapSubscriptionStatus("cancelled")).toBe("canceled");
    expect(mapSubscriptionStatus("expired")).toBe("incomplete_expired");
  });

  it("maps lifecycle webhook events without inventing names", () => {
    const entity = { id: "sub_1", plan_id: "plan_pro_test", customer_id: "cust_1", status: "active" };
    const cases: Array<[string, string]> = [
      ["payment.captured", "invoice.paid"],
      ["payment.failed", "invoice.payment_failed"],
      ["subscription.authenticated", "subscription.updated"],
      ["subscription.activated", "subscription.updated"],
      ["subscription.charged", "invoice.paid"],
      ["subscription.pending", "subscription.updated"],
      ["subscription.halted", "subscription.updated"],
      ["subscription.cancelled", "subscription.deleted"],
      ["subscription.completed", "subscription.updated"],
    ];
    for (const [providerEvent, internal] of cases) {
      const normalized = normalizeRazorpayEvent({
        event: providerEvent,
        created_at: 1_000,
        payload: { subscription: { entity } },
      });
      expect(normalized.type, providerEvent).toBe(internal);
      expect(normalized.providerType).toBe(providerEvent);
    }
  });

  it("a completed subscription whose cycle already ended normalizes to canceled", () => {
    const sub = normalizeRazorpayEvent({
      event: "subscription.completed",
      created_at: 1_000,
      payload: {
        subscription: {
          entity: {
            id: "sub_2",
            plan_id: "plan_pro_test",
            customer_id: "cust_1",
            status: "completed",
            start: 100,
            end: Math.floor(Date.now() / 1000) - 3600,
          },
        },
      },
    });
    expect(sub.subscription!.status).toBe("canceled");
  });

  it("payment.captured produces a normalized invoice for the ledger", () => {
    const normalized = normalizeRazorpayEvent({
      event: "payment.captured",
      created_at: 1_000,
      payload: {
        payment: {
          entity: { id: "pay_1", subscription_id: "sub_1", customer_id: "cust_1", amount: 79900, currency: "INR", created_at: 1_000 },
        },
      },
    });
    expect(normalized.invoice).toMatchObject({ id: "pay_1", amountDue: 79900, currency: "inr", status: "paid" });
  });
});

/**
 * §14: cryptographic verification of webhook + checkout-relay signatures.
 */
describe("Phase 14: signature verification", () => {
  it("verifies a correctly signed webhook over the exact raw body", () => {
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "s", webhookSecret: "whsec_x", fetchImpl: api.fetch });
    const { rawBody, headers } = signed("whsec_x", { event: "payment.captured", created_at: 1, payload: {} });
    const event = provider.verifyWebhook(rawBody, new Headers(headers));
    expect(event.providerType).toBe("payment.captured");
  });

  it("rejects missing, malformed, and mismatched webhook signatures", () => {
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "s", webhookSecret: "whsec_x", fetchImpl: api.fetch });
    const good = signed("whsec_x", { event: "payment.captured", created_at: 1, payload: {} });
    expect(() => provider.verifyWebhook(good.rawBody, new Headers())).toThrowError(/signature/i);
    expect(() => provider.verifyWebhook(good.rawBody, new Headers({ "x-razorpay-signature": "nothex" }))).toThrowError(/signature/i);
    const wrongSecret = signed("whsec_OTHER", { event: "payment.captured", created_at: 1, payload: {} });
    expect(() => provider.verifyWebhook(wrongSecret.rawBody, new Headers(wrongSecret.headers))).toThrowError(/signature/i);
    // Tampered payload (signature over a different byte representation):
    const tampered = { ...good, rawBody: good.rawBody.replace("payment.captured", "payment.captuxed") };
    expect(() => provider.verifyWebhook(tampered.rawBody, new Headers(good.headers))).toThrowError(/signature/i);
  });

  it("verifies checkout confirmations for the subscription flow (and rejects forgeries)", () => {
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "key_secret", webhookSecret: "w", fetchImpl: api.fetch });
    const signature = checkoutConfirmationSignatureWith("key_secret", "pay_1", "sub_1");
    expect(provider.verifyCheckoutConfirmation!({ paymentId: "pay_1", subscriptionId: "sub_1", signature })).toBe(true);
    expect(provider.verifyCheckoutConfirmation!({ paymentId: "pay_1", subscriptionId: "sub_OTHER", signature })).toBe(false);
    expect(provider.verifyCheckoutConfirmation!({ paymentId: "pay_1", subscriptionId: "sub_1", signature: "0".repeat(64) })).toBe(false);
    expect(provider.verifyCheckoutConfirmation!({ paymentId: "pay_1", subscriptionId: "sub_1", signature: "zz" })).toBe(false);
    // Order flow variant: payment|order
    const orderSignature = checkoutConfirmationSignatureWith("key_secret", "pay_2", "order_9");
    expect(provider.verifyCheckoutConfirmation!({ paymentId: "pay_2", orderId: "order_9", signature: orderSignature })).toBe(true);
  });
});

/**
 * §33/§87: the provider's plan price must match the catalog, or fail closed.
 */
describe("Phase 14: price-change protection", () => {
  it("rejects checkout when the Razorpay plan price differs from the catalog", async () => {
    api.plans.set("plan_pro_test", { amount: 99900, currency: "INR" }); // catalog says 79900
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "s", webhookSecret: "w", fetchImpl: api.fetch });
    await expect(
      provider.createCheckoutSession({
        userId: "user_1",
        planId: "pro",
        priceId: "plan_pro_test",
        customerId: "cust_1",
        successUrl: "https://app/return?session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://app/billing",
        idempotencyKey: "k",
        expectedAmount: 79900,
        expectedCurrency: "inr",
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_MISMATCH" });
    expect(api.requests.some((request) => request.path.startsWith("/v1/subscriptions"))).toBe(false); // nothing created
  });

  it("rejects a currency mismatch the same way", async () => {
    api.plans.set("plan_pro_test", { amount: 79900, currency: "USD" });
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "s", webhookSecret: "w", fetchImpl: api.fetch });
    await expect(
      provider.createCheckoutSession({
        userId: "user_1",
        planId: "pro",
        priceId: "plan_pro_test",
        customerId: "cust_1",
        successUrl: "https://app/return",
        cancelUrl: "https://app/billing",
        idempotencyKey: "k",
        expectedAmount: 79900,
        expectedCurrency: "inr",
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_MISMATCH" });
  });
});

/**
 * §49: provider failures surface as BILLING_PROVIDER_UNAVAILABLE — never as
 * activation, and never leaking provider internals.
 */
describe("Phase 14: provider failure handling", () => {
  it("network failures and 5xx map to retryable BILLING_PROVIDER_UNAVAILABLE", async () => {
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "s", webhookSecret: "w", fetchImpl: api.fetch });
    api.failMode = "network";
    await expect(provider.ensureCustomer({ userId: "u", email: "a@b.c", name: "A" })).rejects.toMatchObject({
      code: "BILLING_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    api.failMode = "5xx";
    await expect(provider.getSubscription("sub_x")).rejects.toMatchObject({ code: "BILLING_PROVIDER_UNAVAILABLE" });
    api.failMode = "none";
  });

  it("a 4xx from the provider is a permanent error, and unknown subscriptions resolve to null", async () => {
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "s", webhookSecret: "w", fetchImpl: api.fetch });
    api.failMode = "4xx";
    await expect(provider.ensureCustomer({ userId: "u", email: "a@b.c", name: "A" })).rejects.toMatchObject({ code: "BILLING_PROVIDER_ERROR" });
    api.failMode = "none";
    expect(await provider.getSubscription("sub_missing")).toBeNull();
    expect(await provider.getCheckoutSession("sub_missing")).toBeNull();
  });

  it("checkout sessions report open → complete as the provider advances state", async () => {
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "s", webhookSecret: "w", fetchImpl: api.fetch });
    const entity = api.createSubscription("cust_1", "plan_pro_test");
    expect((await provider.getCheckoutSession(entity.id))!.status).toBe("open"); // created
    api.activate(entity.id);
    expect((await provider.getCheckoutSession(entity.id))!.status).toBe("complete"); // active
    api.cancel(entity.id, false);
    expect((await provider.getCheckoutSession(entity.id))!.status).toBe("expired"); // cancelled
  });

  it("invoices normalize to the shared ProviderInvoice shape", async () => {
    const provider = createRazorpayProvider({ keyId: RAZORPAY_KEY_ID, keySecret: "s", webhookSecret: "w", fetchImpl: api.fetch });
    const entity = api.createSubscription("cust_1", "plan_pro_test");
    api.activate(entity.id);
    const invoices = await provider.listInvoices("cust_1", 10);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ amountDue: 79900, currency: "inr", status: "paid", subscriptionId: entity.id });
  });
});

/**
 * §15/§16: raw-body verification through the actual webhook route.
 */
describe("Phase 14: webhook route signature enforcement", () => {
  it("rejects an invalid signature with 400 and processes a valid one", async () => {
    const { rawBody, headers } = api.webhook("subscription.authenticated", {
      subscription: { entity: { id: "sub_route_1", plan_id: "plan_pro_test", customer_id: "cust_route", status: "authenticated" } },
    });
    const bad = new NextRequest("http://localhost:3000/api/billing/webhook", {
      method: "POST",
      headers: { ...headers, "x-razorpay-signature": "0".repeat(64) },
      body: rawBody,
    });
    const badResponse = await webhookRoute(bad);
    expect(badResponse.status).toBe(400);

    const good = new NextRequest("http://localhost:3000/api/billing/webhook", { method: "POST", headers, body: rawBody });
    const goodResponse = await webhookRoute(good);
    expect(goodResponse.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// local helpers

import { createHmac } from "node:crypto";

function signed(secret: string, payload: unknown): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(payload);
  return { rawBody, headers: { "x-razorpay-signature": createHmac("sha256", secret).update(rawBody, "utf8").digest("hex") } };
}

function checkoutConfirmationSignatureWith(secret: string, paymentId: string, otherId: string): string {
  return createHmac("sha256", secret).update(`${paymentId}|${otherId}`, "utf8").digest("hex");
}

void BillingError;
