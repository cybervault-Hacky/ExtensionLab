import { createHmac } from "node:crypto";
import { setupHarness as setupPhase6Harness, makeUser, type Harness } from "../phase6/helpers";
import { setBillingProviderForTests } from "@/lib/billing/provider";
import { createRazorpayProvider } from "@/lib/billing/providers/razorpay";

export { makeUser };
export type { Harness };

/**
 * Phase 14 harness: Phase 6 isolation + the REAL Razorpay adapter wired to a
 * deterministic in-memory Razorpay API double. Tests exercise production code
 * paths (normalization, signatures, error mapping) — never the real network.
 */

export const RAZORPAY_KEY_ID = "rzp_test_extensionlab01";
export const RAZORPAY_KEY_SECRET = "test_key_secret_phase14";
export const RAZORPAY_WEBHOOK_SECRET = "whsec_test_phase14";

export interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  customer_id: string;
  status: string;
  current_start?: number;
  current_end?: number;
  start?: number;
  end?: number;
  canceled_at?: number;
  notes?: Record<string, string>;
}

/**
 * Deterministic fake of the Razorpay REST API the adapter touches. State is
 * explicit and mutated by the test through `db` so every scenario is exact.
 */
export class FakeRazorpayApi {
  customers = new Map<string, { id: string; email: string }>();
  subscriptions = new Map<string, RazorpaySubscriptionEntity>();
  plans = new Map<string, { amount: number; currency: string }>();
  requests: Array<{ method: string; path: string }> = [];
  /** "network" | "5xx" | "4xx" — provider failure injection. */
  failMode: "none" | "network" | "5xx" | "4xx" = "none";
  private seq = 0;

  constructor() {
    this.plans.set("plan_pro_test", { amount: 79900, currency: "INR" });
    this.plans.set("plan_business_test", { amount: 249900, currency: "INR" });
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_fake${String(this.seq).padStart(4, "0")}`;
  }

  createSubscription(customerId: string, planId: string, notes: Record<string, string> = {}): RazorpaySubscriptionEntity {
    const entity: RazorpaySubscriptionEntity = {
      id: this.id("sub"),
      plan_id: planId,
      customer_id: customerId,
      status: "created",
      notes,
    };
    this.subscriptions.set(entity.id, entity);
    return entity;
  }

  /** Test-side state machine: mirrors Razorpay lifecycle transitions. */
  activate(subscriptionId: string, now = Date.now()): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`unknown subscription ${subscriptionId}`);
    sub.status = "active";
    sub.current_start = Math.floor(now / 1000);
    sub.current_end = Math.floor((now + 30 * 24 * 3600 * 1000) / 1000);
  }

  halt(subscriptionId: string): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (sub) sub.status = "halted";
  }

  cancel(subscriptionId: string, atCycleEnd: boolean, now = Date.now()): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;
    if (atCycleEnd) {
      // Razorpay keeps the subscription active until end; entity gains an end date.
      if (!sub.current_end) sub.current_end = Math.floor((now + 20 * 24 * 3600 * 1000) / 1000);
    } else {
      sub.status = "cancelled";
      sub.canceled_at = Math.floor(now / 1000);
    }
  }

  /** Builds a signed webhook exactly the way Razorpay delivers them. */
  webhook(event: string, payload: Record<string, unknown>, eventId?: string, createdAt = Date.now()): { rawBody: string; headers: Record<string, string> } {
    const body = JSON.stringify({
      event,
      event_id: eventId ?? `evt_${event.replace(/\./g, "_")}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: Math.floor(createdAt / 1000),
      payload,
    });
    const signature = createHmac("sha256", RAZORPAY_WEBHOOK_SECRET).update(body, "utf8").digest("hex");
    return { rawBody: body, headers: { "x-razorpay-signature": signature } };
  }

  /** The fetch implementation handed to the real adapter. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname + new URL(url).search;
    this.requests.push({ method, path });

    if (this.failMode === "network") throw new Error("simulated network failure");
    if (this.failMode === "5xx") return Response.json({ error: { code: "SERVER_ERROR" } }, { status: 502 });
    if (this.failMode === "4xx") return Response.json({ error: { code: "BAD_REQUEST_ERROR" } }, { status: 400 });

    const body = new URLSearchParams(init?.body ? String(init.body) : "");
    const respond = (data: unknown, status = 200) => Response.json(data, { status });

    if (method === "POST" && path === "/v1/customers") {
      const id = this.id("cust");
      this.customers.set(id, { id, email: body.get("email") ?? "" });
      return respond({ id, email: body.get("email"), object: "customer" });
    }
    if (method === "POST" && path === "/v1/subscriptions") {
      const entity = this.createSubscription(body.get("customer_id") ?? "", body.get("plan_id") ?? "", {
        userId: body.get("notes[userId]") ?? "",
        planId: body.get("notes[planId]") ?? "",
      });
      return respond({ ...entity, object: "subscription" });
    }
    const subMatch = path.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (method === "GET" && subMatch) {
      const sub = this.subscriptions.get(subMatch[1]);
      if (!sub) return Response.json({ error: { code: "BAD_REQUEST_ERROR" } }, { status: 400 });
      return respond({ ...sub, object: "subscription" });
    }
    const cancelMatch = path.match(/^\/v1\/subscriptions\/([^/]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      const sub = this.subscriptions.get(cancelMatch[1]);
      if (!sub) return Response.json({ error: { code: "BAD_REQUEST_ERROR" } }, { status: 400 });
      this.cancel(sub.id, body.get("cancel_at_cycle_end") === "1");
      return respond({ ...this.subscriptions.get(sub.id)!, object: "subscription" });
    }
    const planMatch = path.match(/^\/v1\/plans\/([^/]+)$/);
    if (method === "GET" && planMatch) {
      const plan = this.plans.get(planMatch[1]);
      if (!plan) return Response.json({ error: { code: "BAD_REQUEST_ERROR" } }, { status: 400 });
      return respond({ id: planMatch[1], object: "plan", item: { amount: plan.amount, currency: plan.currency } });
    }
    if (method === "GET" && path.startsWith("/v1/invoices")) {
      const customerId = new URL(url).searchParams.get("customer_id") ?? "";
      const invoices = [...this.subscriptions.values()]
        .filter((sub) => sub.customer_id === customerId && sub.current_start)
        .map((sub) => ({
          id: this.id("inv"),
          customer_id: customerId,
          subscription_id: sub.id,
          status: "paid",
          payment_id: this.id("pay"),
          short_url: `https://rzp.io/i/fake`,
          amount: { due: this.plans.get(sub.plan_id)?.amount ?? 0, paid: this.plans.get(sub.plan_id)?.amount ?? 0, currency: "INR" },
          period: { start: sub.current_start, end: sub.current_end },
          created_at: sub.current_start,
        }));
      return respond({ entity: "collection", count: invoices.length, items: invoices });
    }
    return Response.json({ error: { code: "BAD_REQUEST_ERROR" } }, { status: 400 });
  };
}

export function setupPhase14Harness(env: Record<string, string> = {}): Harness & { api: FakeRazorpayApi } {
  const harness = setupPhase6Harness({
    BILLING_PROVIDER: "razorpay",
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET,
    RAZORPAY_PLAN_ID_PRO: "plan_pro_test",
    RAZORPAY_PLAN_ID_BUSINESS: "plan_business_test",
    BILLING_PRO_AMOUNT: "79900",
    BILLING_BUSINESS_AMOUNT: "249900",
    BILLING_CURRENCY: "inr",
    ...env,
  });
  const api = new FakeRazorpayApi();
  setBillingProviderForTests(
    createRazorpayProvider({
      keyId: RAZORPAY_KEY_ID,
      keySecret: RAZORPAY_KEY_SECRET,
      webhookSecret: RAZORPAY_WEBHOOK_SECRET,
      fetchImpl: api.fetch as unknown as typeof fetch,
    }),
  );
  return {
    ...harness,
    api,
    teardown() {
      setBillingProviderForTests(null);
      harness.teardown();
    },
  };
}

/** Signature helper mirroring Razorpay's checkout handler payload. */
export function checkoutConfirmationSignature(paymentId: string, subscriptionId: string): string {
  return createHmac("sha256", RAZORPAY_KEY_SECRET).update(`${paymentId}|${subscriptionId}`, "utf8").digest("hex");
}
