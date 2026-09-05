import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "@/lib/billing/providers/signature";
import { normalizeStripeEvent, normalizeStripeSubscription } from "@/lib/billing/providers/stripe-normalize";
import { createStripeProvider } from "@/lib/billing/providers/stripe";
import { BillingError } from "@/lib/billing/errors";

describe("webhook signature verification", () => {
  const secret = "whsec_unit";
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
  const now = 1_700_000_000;

  it("accepts a valid signature inside the tolerance window", () => {
    const header = signPayload(secret, body, now);
    expect(verifySignature({ secret, rawBody: body, header, nowSeconds: now + 10 })).toEqual({ ok: true });
  });

  it("rejects missing, malformed, wrong-secret, tampered and stale signatures", () => {
    expect(verifySignature({ secret, rawBody: body, header: null, nowSeconds: now })).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature({ secret, rawBody: body, header: "nonsense", nowSeconds: now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignature({ secret, rawBody: body, header: signPayload("whsec_other", body, now), nowSeconds: now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ secret, rawBody: body + " ", header: signPayload(secret, body, now), nowSeconds: now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ secret, rawBody: body, header: signPayload(secret, body, now - 301), nowSeconds: now })).toEqual({ ok: false, reason: "timestamp" });
  });

  it("accepts any one of several v1 signatures (secret rotation) and is byte-exact on the raw body", () => {
    const rotated = `${signPayload("whsec_old", body, now)},v1=${signPayload(secret, body, now).split("v1=")[1]}`;
    expect(verifySignature({ secret, rawBody: body, header: rotated, nowSeconds: now })).toEqual({ ok: true });
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifySignature({ secret, rawBody: reformatted, header: signPayload(secret, body, now), nowSeconds: now })).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("stripe normalization", () => {
  it("maps subscription objects to provider-agnostic shapes with millisecond timestamps", () => {
    const sub = normalizeStripeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      cancel_at_period_end: true,
      cancel_at: 1_700_100_000,
      canceled_at: 1_700_000_500,
      trial_end: null,
      ended_at: null,
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
      items: { data: [{ price: { id: "price_x" } }] },
      metadata: { userId: "usr_1", planId: "pro" },
    });
    expect(sub).toMatchObject({
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      priceId: "price_x",
      cancelAtPeriodEnd: true,
      cancelAt: 1_700_100_000_000,
      currentPeriodStart: 1_700_000_000_000,
      currentPeriodEnd: 1_702_592_000_000,
      metadata: { userId: "usr_1", planId: "pro" },
    });
  });

  it("classifies known event types and marks the rest unknown", () => {
    const known = normalizeStripeEvent({ id: "evt_a", type: "invoice.payment_failed", created: 1_700_000_000, data: { object: { id: "in_1", object: "invoice", customer: "cus_1", subscription: "sub_1", status: "open", amount_due: 500, amount_paid: 0, currency: "inr" } } });
    expect(known.type).toBe("invoice.payment_failed");
    expect(known.invoice?.subscriptionId).toBe("sub_1");
    const unknown = normalizeStripeEvent({ id: "evt_b", type: "charge.refunded", created: 1_700_000_000, data: { object: {} } });
    expect(unknown.type).toBe("unknown");
    expect(unknown.providerType).toBe("charge.refunded");
  });

  it("tolerates unexpected statuses without granting anything", () => {
    const sub = normalizeStripeSubscription({ id: "sub_2", customer: "cus_2", status: "something_new", items: { data: [] } });
    // Unknown statuses collapse to a non-entitling state, never to active/trialing.
    expect(["active", "trialing", "past_due"]).not.toContain(sub.status);
    expect(sub.priceId).toBeNull();
  });
});

describe("stripe REST adapter", () => {
  function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const result = handler(url, init ?? {});
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  it("sends form-encoded requests with the secret only in the Authorization header and maps checkout sessions", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = createStripeProvider({
      secretKey: "sk_test_unit",
      webhookSecret: "whsec_unit",
      fetchImpl: fakeFetch((url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/customers")) return { status: 200, body: { id: "cus_new" } };
        if (url.endsWith("/checkout/sessions")) return { status: 200, body: { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1", customer: "cus_new", status: "open", mode: "subscription", metadata: {} } };
        return { status: 404, body: { error: { message: "nope" } } };
      }),
    });
    const customer = await provider.ensureCustomer({ userId: "usr_1", email: "a@example.com", name: "A" });
    expect(customer.customerId).toBe("cus_new");
    const session = await provider.createCheckoutSession({
      userId: "usr_1",
      planId: "pro",
      priceId: "price_pro",
      customerId: "cus_new",
      successUrl: "https://app.example/return?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://app.example/billing",
      idempotencyKey: "checkout:abc",
    });
    expect(session).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    const checkoutCall = calls.find((call) => call.url.endsWith("/checkout/sessions"))!;
    const headers = checkoutCall.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test_unit");
    expect(headers["idempotency-key"]).toBe("checkout:abc");
    const form = String(checkoutCall.init.body);
    expect(form).toContain("mode=subscription");
    expect(form).toContain(encodeURIComponent("line_items[0][price]") + "=price_pro");
    expect(form).toContain(encodeURIComponent("metadata[userId]") + "=usr_1");
    expect(form).toContain(encodeURIComponent("subscription_data[metadata][planId]") + "=pro");
    expect(form).not.toContain("sk_test_unit");
  });

  it("converts provider errors into safe BillingErrors without exposing Stripe messages", async () => {
    const provider = createStripeProvider({
      secretKey: "sk_test_unit",
      webhookSecret: "whsec_unit",
      fetchImpl: fakeFetch(() => ({ status: 402, body: { error: { type: "card_error", message: "Your card was declined (internal detail 4242)." } } })),
    });
    await expect(provider.createPortalSession({ customerId: "cus_1", returnUrl: "https://app.example/billing" })).rejects.toBeInstanceOf(BillingError);
    try {
      await provider.createPortalSession({ customerId: "cus_1", returnUrl: "https://app.example/billing" });
    } catch (error) {
      const billingError = error as BillingError;
      expect(billingError.code).toBe("BILLING_PROVIDER_ERROR");
      expect(billingError.userMessage).not.toContain("4242");
      expect(billingError.userMessage).not.toContain("declined");
    }
  });

  it("verifies webhooks with the stripe-signature header", () => {
    const provider = createStripeProvider({ secretKey: "sk_test_unit", webhookSecret: "whsec_unit", fetchImpl: fakeFetch(() => ({ status: 500, body: {} })) });
    const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted", created: 1_700_000_000, data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", items: { data: [] } } } });
    const good = new Headers({ "stripe-signature": signPayload("whsec_unit", body, Math.floor(Date.now() / 1000)) });
    expect(provider.verifyWebhook(body, good).type).toBe("subscription.deleted");
    const bad = new Headers({ "stripe-signature": signPayload("whsec_wrong", body, Math.floor(Date.now() / 1000)) });
    expect(() => provider.verifyWebhook(body, bad)).toThrow(BillingError);
    expect(() => provider.verifyWebhook(body, new Headers())).toThrow(/signature/i);
  });
});
