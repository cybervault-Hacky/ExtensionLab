import { NextRequest } from "next/server";
import { createSession } from "@/lib/db/repositories/sessions";
import { generateAuthToken, hashToken } from "@/lib/auth/tokens";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { setBillingProviderForTests } from "@/lib/billing/provider";
import { createFakeProvider, type FakeBillingProvider } from "@/lib/billing/providers/fake";
import { POST as webhookRoute } from "@/app/api/billing/webhook/route";
import { setupHarness as setupPhase6Harness, makeUser, type Harness } from "../phase6/helpers";

export { makeUser };
export type { Harness };

export const FAKE_SECRET = "whsec_test_secret_for_phase7";

/**
 * Phase 7 harness: Phase 6 isolation plus a pinned fake billing provider and
 * price ids so plan ↔ price mapping is exercised exactly as in production.
 */
export function setupBillingHarness(env: Record<string, string> = {}): Harness & { provider: FakeBillingProvider } {
  const harness = setupPhase6Harness({
    BILLING_PROVIDER: "fake",
    BILLING_FAKE_WEBHOOK_SECRET: FAKE_SECRET,
    BILLING_PRO_PRICE_ID: "price_pro_test",
    BILLING_BUSINESS_PRICE_ID: "price_business_test",
    BILLING_PRO_AMOUNT: "79900",
    BILLING_BUSINESS_AMOUNT: "249900",
    BILLING_CURRENCY: "inr",
    ...env,
  });
  const provider = createFakeProvider({ webhookSecret: FAKE_SECRET });
  setBillingProviderForTests(provider);
  return {
    ...harness,
    provider,
    teardown() {
      setBillingProviderForTests(null);
      harness.teardown();
    },
  };
}

export function sessionCookieFor(userId: string): string {
  const token = generateAuthToken();
  createSession({ userId, tokenHash: hashToken(token) });
  return `${SESSION_COOKIE}=${token}`;
}

export function jsonRequest(path: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: {
      host: "localhost:3000",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Posts a signed fake-provider delivery to the real webhook route. */
export async function deliver(delivery: { body: string; headers: Record<string, string> }, overrideHeaders: Record<string, string> = {}): Promise<Response> {
  return webhookRoute(
    new NextRequest("http://localhost:3000/api/billing/webhook", {
      method: "POST",
      headers: { host: "localhost:3000", ...delivery.headers, ...overrideHeaders },
      body: delivery.body,
    }),
  );
}

export async function deliverAll(deliveries: Array<{ body: string; headers: Record<string, string> }>): Promise<Response[]> {
  const responses: Response[] = [];
  for (const delivery of deliveries) responses.push(await deliver(delivery));
  return responses;
}
