import "server-only";
import { getConfig } from "@/lib/config/env";
import { BillingError } from "./errors";
import type { BillingProvider } from "./types";
import { createStripeProvider } from "./providers/stripe";
import { createRazorpayProvider } from "./providers/razorpay";
import { createFakeProvider, type FakeBillingProvider } from "./providers/fake";

/**
 * Provider registry. The application obtains the provider only through
 * `getBillingProvider()`; which adapter is behind it is decided by validated
 * configuration:
 *
 *   BILLING_PROVIDER=stripe   → real Stripe adapter (keys required)
 *   BILLING_PROVIDER=razorpay → Razorpay adapter (Phase 14; keys required)
 *   BILLING_PROVIDER=fake     → in-memory fake (rejected in production)
 *   BILLING_PROVIDER=disabled → billing endpoints answer BILLING_NOT_CONFIGURED;
 *                               everyone is on the Free plan
 */

let cached: { provider: BillingProvider; configRef: ReturnType<typeof getConfig> } | null = null;
let testOverride: BillingProvider | null = null;

/** Deterministic secret for the fake provider when none is configured (dev/test only). */
export const FAKE_WEBHOOK_SECRET_FALLBACK = "whsec_fake_development_only";

export function isBillingEnabled(): boolean {
  if (testOverride) return true;
  return getConfig().billing.provider !== "disabled";
}

export function getBillingProvider(): BillingProvider {
  if (testOverride) return testOverride;
  const config = getConfig();
  if (cached && cached.configRef === config) return cached.provider;
  const billing = config.billing;
  let provider: BillingProvider;
  switch (billing.provider) {
    case "stripe":
      if (!billing.secretKey || !billing.webhookSecret) throw new BillingError("BILLING_NOT_CONFIGURED");
      provider = createStripeProvider({ secretKey: billing.secretKey, webhookSecret: billing.webhookSecret });
      break;
    case "razorpay": {
      const razorpay = billing.razorpay;
      if (!razorpay.keyId || !razorpay.keySecret || !razorpay.webhookSecret) throw new BillingError("BILLING_NOT_CONFIGURED");
      provider = createRazorpayProvider({
        keyId: razorpay.keyId,
        keySecret: razorpay.keySecret,
        webhookSecret: razorpay.webhookSecret,
      });
      break;
    }
    case "fake":
      if (config.appEnv === "production") throw new BillingError("BILLING_NOT_CONFIGURED");
      provider = createFakeProvider({ webhookSecret: billing.fakeWebhookSecret ?? billing.webhookSecret ?? FAKE_WEBHOOK_SECRET_FALLBACK });
      break;
    default:
      throw new BillingError("BILLING_NOT_CONFIGURED");
  }
  cached = { provider, configRef: config };
  return provider;
}

/** The fake provider instance when it is the active provider (dev tooling / tests). */
export function getFakeBillingProvider(): FakeBillingProvider | null {
  const provider = testOverride ?? (isBillingEnabled() ? getBillingProvider() : null);
  return provider && provider.name === "fake" ? (provider as FakeBillingProvider) : null;
}

/** Test helper: pin a provider instance regardless of configuration. */
export function setBillingProviderForTests(provider: BillingProvider | null): void {
  testOverride = provider;
  cached = null;
}
