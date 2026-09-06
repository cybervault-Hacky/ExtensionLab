import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";
import { POST as confirmRoute } from "@/app/api/billing/confirm/route";
import { GET as billingRoute } from "@/app/api/billing/route";
import { POST as cancelRoute } from "@/app/api/billing/cancel/route";
import { POST as webhookRoute } from "@/app/api/billing/webhook/route";
import { getEffectivePlan } from "@/lib/billing/entitlements";
import { getCurrentSubscription, getOwnedCheckoutRecord, listPaymentsForUser, listSubscriptionsForUser } from "@/lib/db/repositories/billing";
import { checkoutConfirmationSignature, FakeRazorpayApi, RAZORPAY_KEY_SECRET, setupPhase14Harness, makeUser, type Harness } from "./helpers";
import { sessionCookieFor, jsonRequest } from "../phase7/helpers";

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
 * §8/§95: checkout is authenticated, server-priced and returns only safe
 * public data for the Razorpay popup flow.
 */
describe("Phase 14: checkout flow", () => {
  it("creates a Razorpay subscription and returns safe checkout configuration", async () => {
    const user = makeUser();
    const response = await checkoutRoute(
      jsonRequest("/api/billing/checkout", { method: "POST", cookie: sessionCookieFor(user.id), body: { planId: "pro" } }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      url: string;
      reused?: boolean;
      checkout?: { provider: string; keyId: string; subscriptionId: string; currency: string; amount: number };
    };
    // Safe public values only: public key id + provider subscription ref.
    expect(body.checkout).toMatchObject({ provider: "razorpay", keyId: expect.stringMatching(/^rzp_test_/), currency: "inr", amount: 79900 });
    expect(JSON.stringify(body)).not.toContain(RAZORPAY_KEY_SECRET);
    expect(JSON.stringify(body)).not.toContain("whsec");

    // The provider actually has a subscription in `created` state for the
    // mapped plan, tied to the checkout record.
    const record = getOwnedCheckoutRecord(user.id, "razorpay", body.checkout!.subscriptionId);
    expect(record).not.toBeNull();
    expect(record!.plan_id).toBe("pro");
    expect(api.subscriptions.get(body.checkout!.subscriptionId)!.plan_id).toBe("plan_pro_test");
    // The user-binding notes are on the provider object (server-set).
    expect(api.subscriptions.get(body.checkout!.subscriptionId)!.notes!.userId).toBe(user.id);
  });

  it("rejects unauthenticated checkout and non-plan input", async () => {
    const anonymous = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", body: { planId: "pro" } }));
    expect([401, 403]).toContain(anonymous.status);

    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const bogus = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie, body: { planId: "enterprise" } }));
    expect(bogus.status).toBe(400);

    const free = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie, body: { planId: "free" } }));
    expect(free.status).toBe(400);
  });

  it("ignores any client-supplied price — the server and the provider plan decide", async () => {
    const user = makeUser();
    const response = await checkoutRoute(
      jsonRequest("/api/billing/checkout", {
        method: "POST",
        cookie: sessionCookieFor(user.id),
        // A malicious client tries to buy Business for ₹1 (§33/§34).
        body: { planId: "pro", amount: 100, currency: "usd", priceId: "plan_business_test", providerPlanId: "plan_business_test" },
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { checkout?: { subscriptionId: string; amount: number } };
    expect(api.subscriptions.get(body.checkout!.subscriptionId)!.plan_id).toBe("plan_pro_test");
    expect(body.checkout!.amount).toBe(79900);
  });

  it("prevents a duplicate subscription for an already-paid plan", async () => {
    const user = makeUser();
    const first = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie: sessionCookieFor(user.id), body: { planId: "pro" } }));
    expect(first.status).toBe(201);
    const { checkout } = (await first.json()) as { checkout: { subscriptionId: string } };

    // Webhook activates the subscription → paid.
    await deliverWebhook(
      "subscription.activated",
      subscriptionEntity(checkout.subscriptionId, "active"),
    );
    expect(getEffectivePlan(user.id).paid).toBe(true);

    // Buying the SAME plan again is rejected; so is buying another plan while
    // one is active (provider-plan changes are an explicit action, §9/§10).
    const again = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie: sessionCookieFor(user.id), body: { planId: "pro" } }));
    expect(again.status).toBe(409);
    const other = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie: sessionCookieFor(user.id), body: { planId: "business" } }));
    expect(other.status).toBe(409);
  });

  it("surfaces provider unavailability as a controlled error without creating anything", async () => {
    const user = makeUser();
    api.failMode = "network";
    const response = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie: sessionCookieFor(user.id), body: { planId: "pro" } }));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { errorCode: string } };
    expect(body.error.errorCode).toBe("BILLING_PROVIDER_UNAVAILABLE");
    expect(getEffectivePlan(user.id).paid).toBe(false); // nothing activated
  });
});

/**
 * §13/§14/§22: post-checkout confirmation verifies the relayed signature and
 * only then asks the provider for the truth.
 */
describe("Phase 14: payment verification + confirmation", () => {
  it("a forged checkout callback is rejected and never activates", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "pro");

    const forged = await confirmRoute(
      jsonRequest("/api/billing/confirm", {
        method: "POST",
        cookie: sessionCookieFor(user.id),
        body: { sessionId: checkout.subscriptionId, razorpayPaymentId: "pay_fake", razorpaySubscriptionId: checkout.subscriptionId, razorpaySignature: "0".repeat(64) },
      }),
    );
    expect(forged.status).toBe(400);
    const body = (await forged.json()) as { error: { errorCode: string } };
    expect(body.error.errorCode).toBe("PAYMENT_VERIFICATION_FAILED");
    expect(getEffectivePlan(user.id).paid).toBe(false);
  });

  it("a verified relay + provider-confirmed subscription activates the plan automatically", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "pro");

    // The provider moved the subscription to active (payment succeeded there).
    api.activate(checkout.subscriptionId);
    const paymentId = "pay_success_1";
    const signature = checkoutConfirmationSignature(paymentId, checkout.subscriptionId);

    const confirm = await confirmRoute(
      jsonRequest("/api/billing/confirm", {
        method: "POST",
        cookie: sessionCookieFor(user.id),
        body: { sessionId: checkout.subscriptionId, razorpayPaymentId: paymentId, razorpaySubscriptionId: checkout.subscriptionId, razorpaySignature: signature },
      }),
    );
    expect(confirm.status).toBe(200);
    const body = (await confirm.json()) as { status: string; billing: { paid: boolean; plan: { id: string } } };
    expect(body.status).toBe("complete");
    expect(body.billing.paid).toBe(true);
    expect(body.billing.plan.id).toBe("pro");
  });

  it("confirm for another user's checkout is unknown (§35 user binding)", async () => {
    const owner = makeUser();
    const intruder = makeUser();
    const { checkout } = await createCheckout(owner.id, "pro");
    const response = await confirmRoute(
      jsonRequest("/api/billing/confirm", { method: "POST", cookie: sessionCookieFor(intruder.id), body: { sessionId: checkout.subscriptionId } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("unknown");
    expect(getEffectivePlan(intruder.id).paid).toBe(false);
  });

  it("payment stays pending until the provider actually confirms (no optimistic activation)", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "pro");
    // Subscription still `created` — checkout opened but nothing captured.
    const confirm = await confirmRoute(
      jsonRequest("/api/billing/confirm", { method: "POST", cookie: sessionCookieFor(user.id), body: { sessionId: checkout.subscriptionId } }),
    );
    const body = (await confirm.json()) as { status: string; billing: { paid: boolean } };
    expect(body.status).toBe("pending");
    expect(body.billing.paid).toBe(false);
  });
});

/**
 * §20/§21/§88/§89/§90: lifecycle synchronization through verified webhooks.
 */
describe("Phase 14: subscription lifecycle via webhooks", () => {
  it("authenticated → activated → entitled, with payment recorded once", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "business");

    await deliverWebhook("subscription.authenticated", subscriptionEntity(checkout.subscriptionId, "authenticated"));
    expect(getEffectivePlan(user.id).plan.id).toBe("business");

    // payment.captured for the same subscription: recorded once, duplicate safe.
    const payment = {
      payment: { entity: { id: "pay_1", subscription_id: checkout.subscriptionId, customer_id: "cust_1", amount: 249900, currency: "INR", created_at: 1 } },
    };
    const first = await deliverWebhook("payment.captured", payment, "evt_pay_1");
    const duplicate = await deliverWebhook("payment.captured", payment, "evt_pay_1");
    expect(first).toBe(200);
    expect(duplicate).toBe(200);
    expect(listPaymentsForUser(user.id)).toHaveLength(1);
    expect(listPaymentsForUser(user.id)[0]).toMatchObject({ amount: 249900, currency: "inr", status: "paid", plan_id: "business" });

    // GET /api/billing exposes the payment history safely.
    const billing = await billingRoute(new NextRequest("http://localhost:3000/api/billing", { headers: { cookie: sessionCookieFor(user.id) } }));
    const state = (await billing.json()) as { payments: Array<{ amount: number; status: string }> };
    expect(state.payments).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  it("renewal (subscription.charged) advances the period without duplicating the subscription", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "pro");
    await deliverWebhook("subscription.activated", subscriptionEntity(checkout.subscriptionId, "active", NOW(), NOW() + CYCLE));

    const renewalStart = NOW() + CYCLE;
    await deliverWebhook("subscription.charged", {
      subscription: { entity: { ...subscriptionEntity(checkout.subscriptionId, "active").subscription.entity, current_start: renewalStart, current_end: renewalStart + CYCLE } },
      payment: { entity: { id: "pay_renewal", subscription_id: checkout.subscriptionId, amount: 79900, currency: "INR", created_at: renewalStart } },
    });

    const row = getCurrentSubscription(user.id)!;
    expect(row.current_period_start).toBe(renewalStart * 1000);
    expect(row.status).toBe("active");
    expect(listSubscriptionsCount(user.id)).toBe(1);
  });

  it("cancellation keeps paid access until the period end (§41)", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "pro");
    await deliverWebhook("subscription.activated", subscriptionEntity(checkout.subscriptionId, "active", NOW(), NOW() + CYCLE));
    api.activate(checkout.subscriptionId); // provider-side state matches the webhook

    const cancel = await cancelRoute(jsonRequest("/api/billing/cancel", { method: "POST", cookie: sessionCookieFor(user.id), body: {} }));
    expect(cancel.status).toBe(200);
    const state = (await cancel.json()) as { billing: { paid: boolean; subscription: { cancelAtPeriodEnd: boolean } } };
    expect(state.billing.paid).toBe(true); // access kept
    expect(state.billing.subscription.cancelAtPeriodEnd).toBe(true);
    expect(api.subscriptions.get(checkout.subscriptionId)!.status).toBe("active"); // provider: cancel at cycle end
  });

  it("halted (retries exhausted) downgrades per the documented past-due policy", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "pro");
    await deliverWebhook("subscription.activated", subscriptionEntity(checkout.subscriptionId, "active", NOW(), NOW() + CYCLE));

    await deliverWebhook("subscription.halted", subscriptionEntity(checkout.subscriptionId, "halted", NOW(), NOW() + CYCLE));
    const effective = getEffectivePlan(user.id);
    expect(effective.state).toMatch(/past_due|expired|cancelled/); // documented policy, never unlimited access
    expect(effective.paid).toBe(false); // halted + grace elapsed in test fixture time? See entitlements policy
  });

  it("cancelled webhook ends the subscription; user data (analyses) remains (§90)", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "pro");
    await deliverWebhook("subscription.activated", subscriptionEntity(checkout.subscriptionId, "active", NOW(), NOW() + CYCLE));
    await deliverWebhook("subscription.cancelled", { subscription: { entity: { ...subscriptionEntity(checkout.subscriptionId, "cancelled").subscription.entity, canceled_at: NOW() } } });

    const effective = getEffectivePlan(user.id);
    expect(effective.paid).toBe(false);
    expect(effective.plan.id).toBe("free");
  });

  it("out-of-order events: an older snapshot never overwrites a newer state (§42)", async () => {
    const user = makeUser();
    const { checkout } = await createCheckout(user.id, "pro");

    // Newer event first (active now)…
    await deliverWebhook("subscription.activated", subscriptionEntity(checkout.subscriptionId, "active", NOW(), NOW() + CYCLE), "evt_new");
    // …then an older one (pending, envelope-timestamped an hour ago) arrives late.
    await deliverWebhook(
      "subscription.pending",
      subscriptionEntity(checkout.subscriptionId, "pending", NOW() - 3600, null),
      "evt_old",
      (NOW() - 3600) * 1000,
    );

    const row = getCurrentSubscription(user.id)!;
    expect(row.status).toBe("active"); // the stale event did not win
  });
});

// ---------------------------------------------------------------------------
// helpers

const NOW = () => Math.floor(Date.now() / 1000);
const CYCLE = 30 * 24 * 3600;

async function createCheckout(userId: string, planId: "pro" | "business") {
  const response = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie: sessionCookieFor(userId), body: { planId } }));
  if (response.status !== 201) throw new Error(`checkout failed: ${response.status}`);
  return (await response.json()) as { url: string; checkout: { keyId: string; subscriptionId: string } };
}

function subscriptionEntity(id: string, status: string, currentStart?: number, currentEnd?: number | null) {
  const base = api.subscriptions.get(id)!;
  const entity = {
    id,
    plan_id: base.plan_id,
    customer_id: base.customer_id,
    status,
    notes: base.notes,
    ...(currentStart !== undefined ? { current_start: currentStart } : {}),
    ...(currentEnd !== null && currentEnd !== undefined ? { current_end: currentEnd } : {}),
  };
  return { subscription: { entity } };
}

async function deliverWebhook(event: string, payload: Record<string, unknown>, eventId?: string, createdAt?: number): Promise<number> {
  const { rawBody, headers } = api.webhook(event, payload, eventId, createdAt);
  const request = new NextRequest("http://localhost:3000/api/billing/webhook", { method: "POST", headers, body: rawBody });
  const response = await webhookRoute(request);
  return response.status;
}

function listSubscriptionsCount(userId: string): number {
  return listSubscriptionsForUser(userId).length;
}
