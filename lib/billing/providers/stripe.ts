import "server-only";
import { BillingError } from "../errors";
import type { BillingProvider, CheckoutSessionResult, CreateCheckoutInput } from "../types";
import { logger, recordMetric } from "@/lib/observability/logger";
import { verifySignature } from "./signature";
import {
  asRecord,
  asString,
  encodeForm,
  normalizeStripeCheckoutSession,
  normalizeStripeEvent,
  normalizeStripeInvoice,
  normalizeStripeSubscription,
  type Json,
} from "./stripe-normalize";

/**
 * Stripe adapter (REST API over fetch; no SDK dependency).
 *
 * Only this file knows Stripe's endpoint names, request encoding and error
 * format (object shapes live in stripe-normalize.ts). It converts everything
 * into the provider-agnostic types from `lib/billing/types` and never lets a
 * raw Stripe error or payload escape: failures become
 * `BillingError("BILLING_PROVIDER_ERROR")` with a safe message, and only the
 * error *type* is logged.
 *
 * Subscriptions are created through Checkout (mode=subscription); payment
 * methods live in Stripe and are managed through the hosted Billing Portal.
 */

const API_BASE = "https://api.stripe.com/v1";
const API_VERSION = "2024-06-20";

interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createStripeProvider(options: StripeOptions): BillingProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    idempotencyKey?: string,
  ): Promise<Json> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const url = method !== "POST" && params ? `${API_BASE}${path}?${encodeForm(params)}` : `${API_BASE}${path}`;
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          "stripe-version": API_VERSION,
          ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: method === "POST" ? encodeForm(params ?? {}) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let body: Json = {};
      try {
        body = asRecord(JSON.parse(text)) ?? {};
      } catch {
        body = {};
      }
      if (!response.ok) {
        const error = asRecord(body.error);
        // Log the Stripe error *type/code* only; messages can echo request data.
        logger.warn("billing.provider_error", {
          component: "billing",
          provider: "stripe",
          path,
          status: response.status,
          errorType: asString(error?.type) ?? "unknown",
          errorCode: "BILLING_PROVIDER_ERROR",
          durationMs: Date.now() - startedAt,
        });
        recordMetric("billing.provider_error", 1, { provider: "stripe", status: String(response.status) });
        const retryable = response.status === 429 || response.status >= 500;
        throw new BillingError("BILLING_PROVIDER_ERROR", { retryable });
      }
      return body;
    } catch (error) {
      if (error instanceof BillingError) throw error;
      logger.warn("billing.provider_unreachable", {
        component: "billing",
        provider: "stripe",
        path,
        errorCode: "BILLING_PROVIDER_ERROR",
        durationMs: Date.now() - startedAt,
      });
      recordMetric("billing.provider_error", 1, { provider: "stripe", status: "network" });
      throw new BillingError("BILLING_PROVIDER_ERROR", { retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "stripe",
    capabilities: { hostedPortal: true, cancelAtPeriodEnd: true, reactivate: true, invoices: true },

    async ensureCustomer(input) {
      const body = await call(
        "POST",
        "/customers",
        { email: input.email, name: input.name, "metadata[userId]": input.userId },
        `customer:${input.userId}`,
      );
      const id = asString(body.id);
      if (!id) throw new BillingError("BILLING_PROVIDER_ERROR");
      return { customerId: id };
    },

    async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSessionResult> {
      const body = await call(
        "POST",
        "/checkout/sessions",
        {
          mode: "subscription",
          customer: input.customerId,
          "line_items[0][price]": input.priceId,
          "line_items[0][quantity]": 1,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.userId,
          "metadata[userId]": input.userId,
          "metadata[planId]": input.planId,
          "subscription_data[metadata][userId]": input.userId,
          "subscription_data[metadata][planId]": input.planId,
          allow_promotion_codes: false,
          billing_address_collection: "auto",
        },
        input.idempotencyKey,
      );
      const id = asString(body.id);
      const url = asString(body.url);
      if (!id || !url) throw new BillingError("CHECKOUT_CREATION_FAILED");
      return { id, url };
    },

    async createPortalSession(input) {
      const body = await call("POST", "/billing_portal/sessions", { customer: input.customerId, return_url: input.returnUrl });
      const url = asString(body.url);
      if (!url) throw new BillingError("BILLING_PROVIDER_ERROR");
      return { url };
    },

    async getCheckoutSession(sessionId) {
      try {
        const body = await call("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
        return normalizeStripeCheckoutSession(body);
      } catch (error) {
        if (error instanceof BillingError && !error.retryable) return null;
        throw error;
      }
    },

    async getSubscription(subscriptionId) {
      try {
        const body = await call("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
        return normalizeStripeSubscription(body);
      } catch (error) {
        if (error instanceof BillingError && !error.retryable) return null;
        throw error;
      }
    },

    async cancelSubscription(subscriptionId, opts) {
      // Period-end cancellation keeps access until current_period_end and can be
      // reverted; immediate cancellation (DELETE) ends the subscription now.
      const body = opts.atPeriodEnd
        ? await call("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: true })
        : await call("DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      return normalizeStripeSubscription(body);
    },

    async reactivateSubscription(subscriptionId) {
      const body = await call("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: false });
      return normalizeStripeSubscription(body);
    },

    async listInvoices(customerId, limit) {
      const body = await call("GET", "/invoices", { customer: customerId, limit: Math.min(Math.max(limit, 1), 50) });
      const data = Array.isArray(body.data) ? (body.data as unknown[]) : [];
      return data.map((item) => asRecord(item)).filter((item): item is Json => item !== null).map(normalizeStripeInvoice);
    },

    verifyWebhook(rawBody, headers) {
      const result = verifySignature({ secret: options.webhookSecret, rawBody, header: headers.get("stripe-signature") });
      if (!result.ok) {
        recordMetric("billing.webhook_rejected", 1, { provider: "stripe", reason: result.reason });
        throw new BillingError("WEBHOOK_SIGNATURE_INVALID");
      }
      let parsed: Json | null;
      try {
        parsed = asRecord(JSON.parse(rawBody));
      } catch {
        parsed = null;
      }
      if (!parsed) throw new BillingError("WEBHOOK_SIGNATURE_INVALID", { message: "The webhook payload is malformed." });
      return normalizeStripeEvent(parsed);
    },
  };
}
