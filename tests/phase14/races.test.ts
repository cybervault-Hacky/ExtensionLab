import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";
import { POST as confirmRoute } from "@/app/api/billing/confirm/route";
import { POST as webhookRoute } from "@/app/api/billing/webhook/route";
import { getEffectivePlan } from "@/lib/billing/entitlements";
import { getCurrentSubscription, listPaymentsForUser, listSubscriptionsForUser } from "@/lib/db/repositories/billing";
import { listSessionEvents } from "@/lib/db/repositories/browser-sessions";
import { checkoutConfirmationSignature, FakeRazorpayApi, setupPhase14Harness, makeUser, type Harness } from "./helpers";
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
 * §91/§92/§93: the payment success callback, the webhook and the return-page
 * confirmation can all race. Outcome must be exactly one subscription, one
 * logical payment and a consistent entitlement.
 */
describe("Phase 14: billing race conditions", () => {
  it("webhook + confirm + duplicate webhook concurrently → one subscription, one payment, consistent state", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const checkoutResponse = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie, body: { planId: "pro" } }));
    const { checkout } = (await checkoutResponse.json()) as { checkout: { subscriptionId: string } };

    // The provider completes payment; the browser relays success, Razorpay
    // delivers the webhook, and the return page polls — all at once.
    api.activate(checkout.subscriptionId);
    const signature = checkoutConfirmationSignature("pay_race_1", checkout.subscriptionId);

    const activationPayload = {
      subscription: {
        entity: {
          ...(await entityFor(checkout.subscriptionId, "active")),
          current_start: Math.floor(Date.now() / 1000),
          current_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        },
      },
    };
    const paymentPayload = {
      payment: { entity: { id: "pay_race_1", subscription_id: checkout.subscriptionId, customer_id: "cust", amount: 79900, currency: "INR", created_at: Math.floor(Date.now() / 1000) } },
    };

    const { rawBody: rawActivation, headers: activationHeaders } = api.webhook("subscription.activated", activationPayload, "evt_race_act");
    const { rawBody: rawPayment, headers: paymentHeaders } = api.webhook("payment.captured", paymentPayload, "evt_race_pay");

    const results = await Promise.all([
      webhookRoute(new NextRequest("http://localhost:3000/api/billing/webhook", { method: "POST", headers: activationHeaders, body: rawActivation })),
      webhookRoute(new NextRequest("http://localhost:3000/api/billing/webhook", { method: "POST", headers: activationHeaders, body: rawActivation })), // duplicate delivery
      webhookRoute(new NextRequest("http://localhost:3000/api/billing/webhook", { method: "POST", headers: paymentHeaders, body: rawPayment })),
      confirmRoute(jsonRequest("/api/billing/confirm", {
        method: "POST",
        cookie,
        body: { sessionId: checkout.subscriptionId, razorpayPaymentId: "pay_race_1", razorpaySubscriptionId: checkout.subscriptionId, razorpaySignature: signature },
      })),
    ]);

    for (const response of results) expect(response.status).toBe(200);

    // Exactly one subscription row for the provider id, one payment, active+paid.
    expect(listSubscriptionsForUser(user.id)).toHaveLength(1);
    expect(listPaymentsForUser(user.id)).toHaveLength(1);
    const effective = getEffectivePlan(user.id);
    expect(effective.paid).toBe(true);
    expect(effective.plan.id).toBe("pro");
    expect(getCurrentSubscription(user.id)!.status).toBe("active");
    void listSessionEvents;
  });

  it("double-click Buy Now produces one provider subscription (idempotent reuse window)", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const [first, second] = await Promise.all([
      checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie, body: { planId: "pro" } })),
      checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie, body: { planId: "pro" } })),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const one = (await first.json()) as { checkout: { subscriptionId: string }; reused: boolean };
    const two = (await second.json()) as { checkout: { subscriptionId: string }; reused: boolean };
    expect(one.checkout.subscriptionId).toBe(two.checkout.subscriptionId);
    expect(one.reused || two.reused).toBe(true);
    // One subscription exists at the provider for this customer.
    expect([...api.subscriptions.values()].filter((sub) => sub.customer_id === one.checkout.subscriptionId || api.customers.has(sub.customer_id)).length).toBeGreaterThanOrEqual(1);
    const distinct = new Set([...api.subscriptions.values()].map((sub) => sub.id));
    expect(distinct.size).toBe(1);
  });
});

async function entityFor(id: string, status: string): Promise<Record<string, unknown>> {
  const base = api.subscriptions.get(id)!;
  return { id, plan_id: base.plan_id, customer_id: base.customer_id, status, notes: base.notes };
}
