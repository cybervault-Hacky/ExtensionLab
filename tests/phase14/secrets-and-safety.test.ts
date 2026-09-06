import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";
import { GET as billingRoute } from "@/app/api/billing/route";
import { GET as plansRoute } from "@/app/api/billing/plans/route";
import { createRazorpayProvider } from "@/lib/billing/providers/razorpay";
import { describeConfig } from "@/lib/config/env";
import { listAuditEvents } from "@/lib/db/repositories/audit";
import { FakeRazorpayApi, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, setupPhase14Harness, makeUser, type Harness } from "./helpers";
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

const SECRETS = [RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET];

/**
 * §44/§68/§75/§77: credentials never appear in API responses, the config
 * projection, audit records, provider error messages or client-side source.
 */
describe("Phase 14: secret safety", () => {
  it("checkout and billing responses contain no secrets", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const checkout = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie, body: { planId: "pro" } }));
    const checkoutBody = await checkout.text();
    for (const secret of SECRETS) expect(checkoutBody).not.toContain(secret);

    const billing = await billingRoute(new NextRequest("http://localhost:3000/api/billing", { headers: { cookie } }));
    const billingBody = await billing.text();
    for (const secret of SECRETS) expect(billingBody).not.toContain(secret);

    const plans = await plansRoute(new NextRequest("http://localhost:3000/api/billing/plans"));
    const plansBody = await plans.text();
    for (const secret of SECRETS) expect(plansBody).not.toContain(secret);
  });

  it("describeConfig never includes credential values", () => {
    const json = JSON.stringify(describeConfig());
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });

  it("provider error messages never echo secrets or provider internals", async () => {
    const provider = createRazorpayProvider({ keyId: "rzp_test_x", keySecret: RAZORPAY_KEY_SECRET, webhookSecret: RAZORPAY_WEBHOOK_SECRET, fetchImpl: api.fetch });
    api.failMode = "5xx";
    const error = await provider.getSubscription("sub_x").catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain(RAZORPAY_KEY_SECRET);
    expect(String((error as Error).message)).not.toContain("Basic "); // the auth header itself
    api.failMode = "none";
  });

  it("audit records contain safe metadata only (no secrets, no card data)", async () => {
    const user = makeUser();
    const checkout = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie: sessionCookieFor(user.id), body: { planId: "pro" } }));
    expect(checkout.status).toBe(201);
    const events = listAuditEvents(user.id, 50);
    const json = JSON.stringify(events);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(json).not.toContain("card_number");
    expect(json).not.toContain("cvv");
  });

  it("no client-side source references Razorpay secrets (§77 source scan)", () => {
    const clientRoots = ["components", "app"];
    const banned = ["RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(entry)) continue;
        const source = readFileSync(full, "utf8");
        for (const needle of banned) {
          if (source.includes(needle)) offenders.push(`${full}: ${needle}`);
        }
        if (/NEXT_PUBLIC_RAZORPAY/.test(source)) offenders.push(`${full}: NEXT_PUBLIC_RAZORPAY*`);
      }
    };
    for (const root of clientRoots) walk(join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });

  it("the only Razorpay value the browser may see is the public key id (§76)", async () => {
    const user = makeUser();
    const response = await checkoutRoute(jsonRequest("/api/billing/checkout", { method: "POST", cookie: sessionCookieFor(user.id), body: { planId: "pro" } }));
    const body = (await response.json()) as { checkout?: { keyId: string } };
    // Public key id present by design; the secret pair is not.
    expect(body.checkout!.keyId).toMatch(/^rzp_test_/);
    expect(JSON.stringify(body)).not.toContain(RAZORPAY_KEY_SECRET);
  });
});

/**
 * §94: GET /api/billing returns the normalized safe view.
 */
describe("Phase 14: billing status API shape", () => {
  it("returns provider capabilities, plan, state, usage and payments — no internals", async () => {
    const user = makeUser();
    const billing = await billingRoute(new NextRequest("http://localhost:3000/api/billing", { headers: { cookie: sessionCookieFor(user.id) } }));
    const state = (await billing.json()) as Record<string, unknown>;
    expect(state).toHaveProperty("provider");
    expect(state).toHaveProperty("plan");
    expect(state).toHaveProperty("state");
    expect(state).toHaveProperty("usage");
    expect(state).toHaveProperty("payments");
    expect(state).toHaveProperty("plans");
    // Razorpay capabilities are reported honestly: no hosted portal, no reactivate.
    expect(state.provider).toMatchObject({ hostedPortal: false, reactivate: false, invoices: true });
    expect(JSON.stringify(state)).not.toContain("providerSubscriptionId");
    expect(JSON.stringify(state)).not.toContain("provider_customer_id");
  });
});
