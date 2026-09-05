import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as billingRoute } from "@/app/api/billing/route";
import { GET as plansRoute } from "@/app/api/billing/plans/route";
import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";
import { POST as confirmRoute } from "@/app/api/billing/confirm/route";
import { POST as cancelRoute } from "@/app/api/billing/cancel/route";
import { POST as reactivateRoute } from "@/app/api/billing/reactivate/route";
import { POST as portalRoute } from "@/app/api/billing/portal/route";
import { GET as invoicesRoute } from "@/app/api/billing/invoices/route";
import { getEffectivePlan, getQuotaUsage } from "@/lib/billing/entitlements";
import { getBillingEvent, listSubscriptionsForUser } from "@/lib/db/repositories/billing";
import { listAuditEvents } from "@/lib/db/repositories/audit";
import { getDb } from "@/lib/db/client";
import { deleteAccount } from "@/lib/account/deletion";
import { findUserById } from "@/lib/db/repositories/users";
import { setBillingProviderForTests } from "@/lib/billing/provider";
import { deliver, deliverAll, jsonRequest, makeUser, sessionCookieFor, setupBillingHarness, FAKE_SECRET } from "./helpers";
import type { FakeBillingProvider } from "@/lib/billing/providers/fake";

interface BillingBody {
  enabled: boolean;
  plan: { id: string; name: string };
  state: string;
  paid: boolean;
  subscription: { planId: string; cancelAtPeriodEnd: boolean; canCancel: boolean; canReactivate: boolean; currentPeriodEnd: number | null } | null;
  usage: { period: { source: string }; testRuns: { limit: number; used: number; resetAt: number } };
  plans: Array<{ id: string; purchasable: boolean; price: { formatted: string } }>;
}

async function readBilling(cookie: string): Promise<BillingBody> {
  const response = await billingRoute(jsonRequest("/api/billing", { cookie }));
  expect(response.status).toBe(200);
  return (await response.json()) as BillingBody;
}

async function startCheckout(cookie: string, planId: unknown, extra: Record<string, unknown> = {}): Promise<Response> {
  return checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie, body: { planId, ...extra } }));
}

function sessionIdFromUrl(url: string): string {
  return new URL(url).searchParams.get("session_id")!;
}

describe("billing lifecycle through the public API and signed webhooks", () => {
  let harness: ReturnType<typeof setupBillingHarness>;
  let provider: FakeBillingProvider;

  beforeAll(() => {
    harness = setupBillingHarness({ PLAN_TEST_LIMIT: "2" });
    provider = harness.provider;
  });
  afterAll(() => harness.teardown());

  it("exposes the plan catalog publicly without any secret or provider identifiers", async () => {
    const response = await plansRoute(jsonRequest("/api/billing/plans"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("price_pro_test");
    expect(text).not.toContain(FAKE_SECRET);
    const body = JSON.parse(text) as { plans: Array<{ id: string; purchasable: boolean }>; comparison: unknown[] };
    expect(body.plans.map((plan) => plan.id)).toEqual(["free", "pro", "business"]);
    expect(body.plans.find((plan) => plan.id === "pro")?.purchasable).toBe(true);
  });

  it("requires a session for billing state and CSRF-valid same-origin requests for checkout", async () => {
    expect((await billingRoute(jsonRequest("/api/billing"))).status).toBe(401);
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const crossSite = await checkoutRoute(
      jsonRequest("/api/billing/checkout", { method: "POST", cookie, body: { planId: "pro" }, headers: { origin: "https://evil.example" } }),
    );
    expect(crossSite.status).toBe(403);
  });

  it("free → checkout → webhook → pro, ignoring any client supplied price, and activates only through verified state", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const before = await readBilling(cookie);
    expect(before.plan.id).toBe("free");
    expect(before.usage.testRuns.limit).toBe(2);

    // Client tries to smuggle a price/amount/currency: ignored; the server maps plan → configured price.
    const checkout = await startCheckout(cookie, "pro", { priceId: "price_evil", amount: 1, currency: "usd" });
    expect(checkout.status).toBe(201);
    const { url } = (await checkout.json()) as { url: string };
    const sessionId = sessionIdFromUrl(url);
    const fakeSession = provider.fake.checkouts.get(sessionId)!;
    expect(fakeSession.priceId).toBe("price_pro_test");
    expect(fakeSession.metadata.userId).toBe(user.id);

    // Returning from checkout before payment confirmation grants nothing.
    const pending = await confirmRoute(jsonRequest("/api/billing/confirm", { method: "POST", cookie, body: { sessionId } }));
    expect(((await pending.json()) as { status: string }).status).toBe("pending");
    expect(getEffectivePlan(user.id).plan.id).toBe("free");

    // Provider confirms payment → signed webhooks.
    const { events } = provider.fake.completeCheckout(sessionId);
    const responses = await deliverAll(events);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);

    const after = await readBilling(cookie);
    expect(after.plan.id).toBe("pro");
    expect(after.state).toBe("active");
    expect(after.paid).toBe(true);
    expect(after.usage.testRuns.limit).toBe(100);
    expect(after.usage.period.source).toBe("subscription");
    expect(after.subscription?.canCancel).toBe(true);

    const audit = listAuditEvents(user.id, 20).map((row) => row.type);
    expect(audit).toContain("checkout_started");
    expect(audit).toContain("subscription_activated");
    expect(audit).toContain("payment_succeeded");

    // Repeating the checkout for an active plan is refused with a clear state error.
    const again = await startCheckout(cookie, "pro");
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { errorCode: string } }).error.errorCode).toBe("SUBSCRIPTION_STATE_INVALID");
  });

  it("processes a duplicate webhook exactly once", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const { url } = (await (await startCheckout(cookie, "pro")).json()) as { url: string };
    const { events, subscription } = provider.fake.completeCheckout(sessionIdFromUrl(url));
    await deliverAll(events);
    const created = events[0];
    const eventId = (created.event as { id: string }).id;
    expect(getBillingEvent("fake", eventId)?.result).toBe("processed");

    const dup = await deliver(created);
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as { outcome: string }).outcome).toBe("duplicate");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM billing_events WHERE provider_event_id = ?").get(eventId) as { n: number };
    expect(rows.n).toBe(1);
    expect(listSubscriptionsForUser(user.id)).toHaveLength(1);
    expect(listSubscriptionsForUser(user.id)[0].provider_subscription_id).toBe(subscription.id);
  });

  it("rejects webhooks with a missing, wrong-secret, tampered or stale signature and never applies them", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const { url } = (await (await startCheckout(cookie, "pro")).json()) as { url: string };
    const { events } = provider.fake.completeCheckout(sessionIdFromUrl(url));
    const created = events[0];

    const missing = await deliver({ body: created.body, headers: { "content-type": "application/json" } });
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as { error: { errorCode: string } };
    expect(missingBody.error.errorCode).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(JSON.stringify(missingBody)).not.toMatch(/stack|at .*\.ts/);

    const wrongSecret = provider.fake.sign(created.event, { secret: "whsec_other" });
    expect((await deliver(wrongSecret)).status).toBe(400);

    const tampered = { ...created, body: created.body.replace('"status":"active"', '"status":"trialing"') };
    expect((await deliver(tampered)).status).toBe(400);

    const stale = provider.fake.sign(created.event, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await deliver(stale)).status).toBe(400);

    expect(getEffectivePlan(user.id).plan.id).toBe("free");
    expect(getBillingEvent("fake", (created.event as { id: string }).id)).toBeNull();

    // The genuine delivery still works afterwards.
    expect((await deliver(created)).status).toBe(200);
    expect(getEffectivePlan(user.id).plan.id).toBe("pro");
  });

  it("ignores unknown event types after verifying them and records nothing harmful", async () => {
    const delivery = provider.fake.sign({ id: "evt_unknown_1", object: "event", type: "customer.updated", created: Math.floor(Date.now() / 1000), data: { object: { id: "cus_x" } } });
    const response = await deliver(delivery);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { outcome: string }).outcome).toBe("ignored");
    expect(getBillingEvent("fake", "evt_unknown_1")?.result).toBe("ignored");
  });

  it("cancel at period end keeps access until the period ends; reactivate reverts it; expiry downgrades to free", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const { url } = (await (await startCheckout(cookie, "pro")).json()) as { url: string };
    const { events, subscription } = provider.fake.completeCheckout(sessionIdFromUrl(url));
    await deliverAll(events);

    const cancelled = await cancelRoute(jsonRequest("/api/billing/cancel", { method: "POST", cookie }));
    expect(cancelled.status).toBe(200);
    const afterCancel = ((await cancelled.json()) as { billing: BillingBody }).billing;
    expect(afterCancel.state).toBe("cancel_scheduled");
    expect(afterCancel.paid).toBe(true);
    expect(afterCancel.plan.id).toBe("pro");
    expect(afterCancel.subscription?.cancelAtPeriodEnd).toBe(true);
    expect(afterCancel.subscription?.canReactivate).toBe(true);
    expect(provider.fake.subscriptions.get(subscription.id)?.cancelAtPeriodEnd).toBe(true);
    // Idempotent.
    expect((await cancelRoute(jsonRequest("/api/billing/cancel", { method: "POST", cookie }))).status).toBe(200);

    const reactivated = await reactivateRoute(jsonRequest("/api/billing/reactivate", { method: "POST", cookie }));
    expect(reactivated.status).toBe(200);
    const afterReactivate = ((await reactivated.json()) as { billing: BillingBody }).billing;
    expect(afterReactivate.state).toBe("active");
    expect(afterReactivate.subscription?.cancelAtPeriodEnd).toBe(false);
    expect(listAuditEvents(user.id, 20).map((row) => row.type)).toEqual(expect.arrayContaining(["subscription_cancelled", "subscription_reactivated"]));

    // Cancel again, then the period ends on the provider side.
    await cancelRoute(jsonRequest("/api/billing/cancel", { method: "POST", cookie }));
    const ended = provider.fake.expire(subscription.id);
    expect((await deliver(ended)).status).toBe(200);
    const final = await readBilling(cookie);
    expect(final.plan.id).toBe("free");
    expect(final.state).toBe("cancelled");
    expect(final.paid).toBe(false);
    expect(final.subscription?.planId).toBe("pro");
    // Data retained: the user row and audit trail still exist.
    expect(findUserById(user.id)).not.toBeNull();
  });

  it("past_due keeps paid access during the grace period and records payment_failed", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const { url } = (await (await startCheckout(cookie, "pro")).json()) as { url: string };
    const { events, subscription } = provider.fake.completeCheckout(sessionIdFromUrl(url));
    await deliverAll(events);

    const failed = provider.fake.invoice(subscription.id, "failed", 79900);
    expect((await deliver(failed)).status).toBe(200);
    const updated = provider.fake.updateSubscription(subscription.id, { status: "past_due" });
    expect((await deliver(updated)).status).toBe(200);

    const state = await readBilling(cookie);
    expect(state.state).toBe("past_due_grace");
    expect(state.paid).toBe(true);
    expect(state.plan.id).toBe("pro");
    expect(listAuditEvents(user.id, 20).map((row) => row.type)).toContain("payment_failed");

    // Recovery: payment succeeds and the provider moves the subscription back to active with a new period.
    const now = Date.now();
    const recovered = provider.fake.updateSubscription(subscription.id, { status: "active", currentPeriodStart: now, currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000 });
    expect((await deliver(recovered)).status).toBe(200);
    expect((await deliver(provider.fake.invoice(subscription.id, "paid", 79900))).status).toBe(200);
    expect((await readBilling(cookie)).state).toBe("active");
  });

  it("resets usage per billing period for paid plans", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const { url } = (await (await startCheckout(cookie, "pro")).json()) as { url: string };
    const { events, subscription } = provider.fake.completeCheckout(sessionIdFromUrl(url));
    await deliverAll(events);
    const { recordUsage } = await import("@/lib/db/repositories/usage");
    recordUsage(user.id, "test_run");
    recordUsage(user.id, "test_run");
    expect(getQuotaUsage(user.id, "test_run").used).toBe(2);

    // Renewal: the provider starts a new period after the usage above
    // (timestamps have second precision, so wait for the next second).
    const periodStart = (Math.floor(Date.now() / 1000) + 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, periodStart - Date.now() + 5));
    const periodEnd = periodStart + 30 * 24 * 60 * 60 * 1000;
    const renewed = provider.fake.updateSubscription(subscription.id, { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd });
    expect((await deliver(renewed)).status).toBe(200);
    const usage = getQuotaUsage(user.id, "test_run");
    expect(usage.used).toBe(0);
    expect(usage.resetAt).toBe(periodEnd);
    expect((await readBilling(cookie)).usage.testRuns.resetAt).toBe(periodEnd);
  });

  it("only exposes a user's own invoices and never provider secrets or raw payloads", async () => {
    const alice = makeUser();
    const bob = makeUser();
    const aliceCookie = sessionCookieFor(alice.id);
    const bobCookie = sessionCookieFor(bob.id);
    const { url } = (await (await startCheckout(aliceCookie, "business")).json()) as { url: string };
    const { events } = provider.fake.completeCheckout(sessionIdFromUrl(url));
    await deliverAll(events);

    const aliceInvoices = (await (await invoicesRoute(jsonRequest("/api/billing/invoices", { cookie: aliceCookie }))).json()) as { invoices: Array<{ hostedUrl: string | null; status: string }> };
    expect(aliceInvoices.invoices).toHaveLength(1);
    expect(aliceInvoices.invoices[0].status).toBe("paid");
    expect(aliceInvoices.invoices[0].hostedUrl).toMatch(/^https:\/\//);

    const bobInvoices = (await (await invoicesRoute(jsonRequest("/api/billing/invoices", { cookie: bobCookie }))).json()) as { invoices: unknown[] };
    expect(bobInvoices.invoices).toEqual([]);

    const bobState = await readBilling(bobCookie);
    expect(bobState.plan.id).toBe("free");
    expect(bobState.subscription).toBeNull();

    // Bob cannot cancel or reactivate Alice's subscription; he has none.
    expect((await cancelRoute(jsonRequest("/api/billing/cancel", { method: "POST", cookie: bobCookie }))).status).toBe(404);
    expect((await reactivateRoute(jsonRequest("/api/billing/reactivate", { method: "POST", cookie: bobCookie }))).status).toBe(404);
    // Bob cannot confirm Alice's checkout session.
    const stolen = await confirmRoute(jsonRequest("/api/billing/confirm", { method: "POST", cookie: bobCookie, body: { sessionId: sessionIdFromUrl(url) } }));
    expect(((await stolen.json()) as { status: string }).status).toBe("unknown");

    const raw = JSON.stringify(await readBilling(aliceCookie));
    expect(raw).not.toContain(FAKE_SECRET);
    expect(raw).not.toContain("price_business_test");
    expect(raw).not.toContain("cus_fake");
    expect(raw).not.toContain("sub_fake");
  });

  it("rejects invalid plans and reports provider failures without leaking details", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    expect((await startCheckout(cookie, "enterprise")).status).toBe(400);
    expect((await startCheckout(cookie, "free")).status).toBe(400);
    provider.fake.failNext(1);
    const failed = await startCheckout(cookie, "pro");
    expect(failed.status).toBe(502);
    const body = (await failed.json()) as { error: { errorCode: string; message: string; referenceId: string } };
    expect(body.error.errorCode).toBe("BILLING_PROVIDER_ERROR");
    expect(body.error.referenceId).toMatch(/^[0-9A-F]{12}$/);
    expect(failed.headers.get("x-request-id")).toMatch(/^req_/);
    expect(body.error.message).not.toMatch(/stack|fake|stripe/i);
  });

  it("opens the hosted portal only for users with a billing account", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    expect((await portalRoute(jsonRequest("/api/billing/portal", { method: "POST", cookie }))).status).toBe(404);
    const { url } = (await (await startCheckout(cookie, "pro")).json()) as { url: string };
    await deliverAll(provider.fake.completeCheckout(sessionIdFromUrl(url)).events);
    const portal = await portalRoute(jsonRequest("/api/billing/portal", { method: "POST", cookie }));
    expect(portal.status).toBe(200);
    expect(((await portal.json()) as { url: string }).url).toContain("/dashboard/billing");
  });

  it("account deletion cancels the provider subscription deterministically before removing data", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const { url } = (await (await startCheckout(cookie, "pro")).json()) as { url: string };
    const { events, subscription } = provider.fake.completeCheckout(sessionIdFromUrl(url));
    await deliverAll(events);

    const result = await deleteAccount(user.id);
    expect(result.subscriptionsCancelled).toBe(1);
    expect(provider.fake.subscriptions.get(subscription.id)?.status).toBe("canceled");
    expect(findUserById(user.id)).toBeNull();
    expect(listSubscriptionsForUser(user.id)).toHaveLength(0);
    // Late webhooks for the deleted user's subscription are accepted (200) but ignored.
    const late = provider.fake.expire(subscription.id);
    const response = await deliver(late);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { outcome: string }).outcome).toBe("ignored");
  });

  it("refuses account deletion when the provider cannot cancel, so no orphaned paid subscription remains", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const { url } = (await (await startCheckout(cookie, "pro")).json()) as { url: string };
    await deliverAll(provider.fake.completeCheckout(sessionIdFromUrl(url)).events);
    provider.fake.failNext(1);
    await expect(deleteAccount(user.id)).rejects.toMatchObject({ code: "BILLING_PROVIDER_ERROR", retryable: true });
    expect(findUserById(user.id)).not.toBeNull();
  });

  it("returns BILLING_NOT_CONFIGURED when billing is disabled and keeps everyone on Free", async () => {
    setBillingProviderForTests(null);
    process.env.BILLING_PROVIDER = "disabled";
    const { resetConfigCache } = await import("@/lib/config/env");
    resetConfigCache();
    try {
      const user = makeUser();
      const cookie = sessionCookieFor(user.id);
      const state = await readBilling(cookie);
      expect(state.enabled).toBe(false);
      expect(state.plan.id).toBe("free");
      const checkout = await startCheckout(cookie, "pro");
      expect(checkout.status).toBe(503);
      expect(((await checkout.json()) as { error: { errorCode: string } }).error.errorCode).toBe("BILLING_NOT_CONFIGURED");
      const webhook = await deliver({ body: "{}", headers: { "stripe-signature": "t=1,v1=00" } });
      expect(webhook.status).toBe(404);
    } finally {
      process.env.BILLING_PROVIDER = "fake";
      resetConfigCache();
      setBillingProviderForTests(provider);
    }
  });
});
