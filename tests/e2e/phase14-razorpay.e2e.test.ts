/**
 * Phase 14 real-Razorpay e2e suite (test-mode credentials only).
 *
 * Flag: EXTENSIONLAB_E2E_RAZORPAY=1
 *
 * Default: skips with an explicit reason. Flagged and missing credentials:
 * HARD FAILURE — a real-provider result is never faked.
 *
 * What runs against the real Razorpay Test API:
 * - customer + subscription creation on the configured plan mapping
 * - subscription fetch + cancel (no payment is ever made)
 * - webhook signature verification round-trip with the configured secret
 *
 * What does NOT run here: real payments. Checkout completion is exercised by
 * the deterministic suite (tests/phase14) against the provider contract.
 */
import { describe, expect, it } from "vitest";
import { connect as tcpConnect } from "node:net";

const RUN = process.env.EXTENSIONLAB_E2E_RAZORPAY === "1";
const reason = "EXTENSIONLAB_E2E_RAZORPAY=1 not set (set it with Razorpay TEST-mode credentials to run this suite)";

function canReach(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function realProvider() {
  const { createRazorpayProvider } = await import("@/lib/billing/providers/razorpay");
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
  const planId = process.env.RAZORPAY_PLAN_ID_PRO ?? process.env.RAZORPAY_PLAN_ID_BUSINESS ?? "";
  if (!/^rzp_(test|live)_/.test(keyId)) {
    throw new Error("EXTENSIONLAB_E2E_RAZORPAY=1 requires RAZORPAY_KEY_ID (rzp_test_…). Production credentials must never be used for automated tests.");
  }
  if (!keySecret || !webhookSecret) {
    throw new Error("EXTENSIONLAB_E2E_RAZORPAY=1 requires RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET (test mode).");
  }
  if (!planId) throw new Error("EXTENSIONLAB_E2E_RAZORPAY=1 requires RAZORPAY_PLAN_ID_PRO or RAZORPAY_PLAN_ID_BUSINESS.");
  if (keyId.startsWith("rzp_live_")) {
    throw new Error("Refusing to run automated tests against live Razorpay credentials. Use test mode.");
  }
  return { provider: createRazorpayProvider({ keyId, keySecret, webhookSecret }), planId };
}

describe("e2e phase14: Razorpay test-mode provider (EXTENSIONLAB_E2E_RAZORPAY=1)", { sequential: true }, () => {
  it.skipIf(!RUN)(reason, () => {
    expect(RUN).toBe(true);
  });

  it.skipIf(!RUN)("api.razorpay.com is reachable", async () => {
    expect(await canReach("api.razorpay.com", 443)).toBe(true);
  });

  it.skipIf(!RUN)("customer + subscription lifecycle against the real API (no payment)", async () => {
    const { provider, planId } = await realProvider();
    const customer = await provider.ensureCustomer({
      userId: `e2e_${Date.now()}`,
      email: `e2e-${Date.now()}@example.com`,
      name: "ExtensionLab E2E",
    });
    expect(customer.customerId).toMatch(/^cust_/);

    const subscription = await provider.createCheckoutSession({
      userId: "e2e",
      planId: "pro",
      priceId: planId,
      customerId: customer.customerId,
      successUrl: "https://example.com/return?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://example.com/cancel",
      idempotencyKey: `e2e:${Date.now()}`,
    });
    expect(subscription.id).toMatch(/^sub_/);
    expect(subscription.checkout?.keyId).toMatch(/^rzp_test_/);

    const fetched = await provider.getSubscription(subscription.id);
    expect(fetched!.status).toBe("incomplete"); // created, awaiting payment — never activated here

    // Cancel immediately so nothing can ever be charged on this subscription.
    const cancelled = await provider.cancelSubscription(subscription.id, { atPeriodEnd: false });
    expect(cancelled.status).toBe("canceled");
  });

  it.skipIf(!RUN)("webhook signature verification with the configured secret", async () => {
    const { provider } = await realProvider();
    const { createHmac } = await import("node:crypto");
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET!;
    const rawBody = JSON.stringify({ event: "subscription.activated", created_at: 1, payload: { subscription: { entity: { id: "sub_e2e" } } } });
    const signature = createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex");
    const event = provider.verifyWebhook(rawBody, new Headers({ "x-razorpay-signature": signature }));
    expect(event.providerType).toBe("subscription.activated");
    // And a forged signature is still rejected:
    expect(() => provider.verifyWebhook(rawBody, new Headers({ "x-razorpay-signature": "0".repeat(64) }))).toThrow();
  });
});
