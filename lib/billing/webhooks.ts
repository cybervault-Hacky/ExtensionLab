import "server-only";
import { getDb, transaction } from "@/lib/db/client";
import {
  claimBillingEvent,
  finishBillingEvent,
  findUserIdByProviderCustomer,
  getCheckoutRecordByProviderSession,
  getSubscriptionByProviderId,
  updateCheckoutStatus,
  upsertBillingCustomer,
} from "@/lib/db/repositories/billing";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import { logger, recordMetric } from "@/lib/observability/logger";
import { BillingError } from "./errors";
import { getBillingProvider } from "./provider";
import { applyProviderSubscription } from "./subscriptions";
import type { ProviderEvent } from "./types";

/**
 * Webhook processing.
 *
 *   raw body + headers
 *     → provider.verifyWebhook()      (signature; throws on failure)
 *     → claimBillingEvent()           (idempotency: duplicate → no-op)
 *     → handle inside one transaction (subscription upsert, audit, customer link)
 *     → finishBillingEvent(processed) (same transaction)
 *
 * If handling throws, the transaction rolls back *including* the claim's
 * "processing" mark being turned into "failed", so the provider's retry is
 * processed again. The event is never marked processed unless the state
 * change committed.
 */

export type WebhookOutcome = "processed" | "duplicate" | "ignored";

export function verifyWebhookRequest(rawBody: string, headers: Headers): ProviderEvent {
  return getBillingProvider().verifyWebhook(rawBody, headers);
}

export async function processProviderEvent(event: ProviderEvent): Promise<WebhookOutcome> {
  const provider = getBillingProvider();
  const startedAt = Date.now();
  const claim = claimBillingEvent({
    provider: provider.name,
    providerEventId: event.id,
    eventType: event.type,
    providerEventType: event.providerType,
  });
  if (!claim) {
    recordMetric("billing.webhook_duplicate", 1, { provider: provider.name, type: event.type });
    logger.info("billing.webhook_duplicate", { component: "billing", provider: provider.name, providerEventId: event.id, eventType: event.type });
    return "duplicate";
  }

  try {
    // Events that reference a subscription only by id (invoices) may need the
    // provider's current subscription state; fetch it *before* the transaction.
    const hydrated = await hydrate(event);
    const outcome = transaction(getDb(), () => {
      const result = handle(provider.name, hydrated);
      finishBillingEvent(claim.id, { result: result.outcome === "ignored" ? "ignored" : "processed", userId: result.userId, subscriptionId: result.subscriptionId });
      return result.outcome;
    });
    recordMetric("billing.webhook_processed", 1, { provider: provider.name, type: event.type, outcome });
    logger.info("billing.webhook_processed", {
      component: "billing",
      provider: provider.name,
      providerEventId: event.id,
      eventType: event.type,
      providerEventType: event.providerType,
      outcome,
      durationMs: Date.now() - startedAt,
      result: "ok",
    });
    return outcome;
  } catch (error) {
    finishBillingEvent(claim.id, { result: "failed" });
    recordMetric("billing.webhook_failed", 1, { provider: provider.name, type: event.type });
    logger.error("billing.webhook_failed", {
      component: "billing",
      provider: provider.name,
      providerEventId: event.id,
      eventType: event.type,
      errorCode: error instanceof BillingError ? error.code : "INTERNAL",
      durationMs: Date.now() - startedAt,
      result: "error",
    });
    throw error;
  }
}

async function hydrate(event: ProviderEvent): Promise<ProviderEvent> {
  if (event.subscription || !event.invoice?.subscriptionId) return event;
  if (event.type !== "invoice.paid" && event.type !== "invoice.payment_failed") return event;
  const provider = getBillingProvider();
  const subscription = await provider.getSubscription(event.invoice.subscriptionId);
  return subscription ? { ...event, subscription } : event;
}

interface HandleResult {
  outcome: WebhookOutcome;
  userId: string | null;
  subscriptionId: string | null;
}

function handle(providerName: string, event: ProviderEvent): HandleResult {
  switch (event.type) {
    case "checkout.completed": {
      const session = event.checkoutSession;
      if (!session) return { outcome: "ignored", userId: null, subscriptionId: null };
      const record = getCheckoutRecordByProviderSession(providerName, session.id);
      const userId = record?.user_id ?? (session.metadata.userId ?? null);
      if (record) updateCheckoutStatus(providerName, session.id, session.status === "expired" ? "expired" : "complete");
      if (userId && session.customerId) {
        upsertBillingCustomer({ userId, provider: providerName, providerCustomerId: session.customerId });
      }
      // Activation itself comes from the subscription object (created/updated
      // events); checkout completion alone never grants entitlements.
      let subscriptionId: string | null = null;
      if (event.subscription && userId) {
        const applied = applyProviderSubscription({ provider: providerName, subscription: event.subscription, eventAt: event.createdAt, userId, source: "webhook" });
        subscriptionId = applied?.row.id ?? null;
      }
      return { outcome: "processed", userId, subscriptionId };
    }
    case "subscription.created":
    case "subscription.updated":
    case "subscription.deleted": {
      if (!event.subscription) return { outcome: "ignored", userId: null, subscriptionId: null };
      const applied = applyProviderSubscription({ provider: providerName, subscription: event.subscription, eventAt: event.createdAt, source: "webhook" });
      if (!applied) return { outcome: "ignored", userId: null, subscriptionId: null };
      return { outcome: "processed", userId: applied.userId, subscriptionId: applied.row.id };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.invoice;
      if (!invoice) return { outcome: "ignored", userId: null, subscriptionId: null };
      let userId: string | null = null;
      let subscriptionId: string | null = null;
      if (event.subscription) {
        const applied = applyProviderSubscription({ provider: providerName, subscription: event.subscription, eventAt: event.createdAt, source: "webhook" });
        userId = applied?.userId ?? null;
        subscriptionId = applied?.row.id ?? null;
      }
      if (!userId && invoice.subscriptionId) {
        const local = getSubscriptionByProviderId(providerName, invoice.subscriptionId);
        userId = local?.user_id ?? null;
        subscriptionId = local?.id ?? null;
      }
      if (!userId) userId = findUserIdByProviderCustomer(providerName, invoice.customerId);
      if (userId) {
        recordAuditEvent({
          userId,
          type: event.type === "invoice.paid" ? "payment_succeeded" : "payment_failed",
          // Amount + currency only; never payment instrument details.
          detail: `${event.type === "invoice.paid" ? "Paid" : "Failed"} · ${(invoice.amountDue / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
        });
        recordMetric(event.type === "invoice.paid" ? "billing.payment_succeeded" : "billing.payment_failed", 1, { provider: providerName });
      }
      return { outcome: userId ? "processed" : "ignored", userId, subscriptionId };
    }
    case "invoice.created":
    case "unknown":
    default:
      return { outcome: "ignored", userId: null, subscriptionId: null };
  }
}
