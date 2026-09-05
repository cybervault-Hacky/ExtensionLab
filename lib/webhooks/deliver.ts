import "server-only";
import { getConfig } from "@/lib/config/env";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  getWebhookById,
  getWebhookDeliveryById,
  updateWebhookDelivery,
} from "@/lib/organizations/repository";
import { signWebhookPayload } from "./signing";
import { validateWebhookDestination } from "./destination";

/**
 * Webhook delivery execution (Phase 10).
 *
 * One attempt per invocation: the destination is re-validated with a fresh DNS
 * resolution (rebinding protection), the payload is signed with a timestamp
 * and event id, redirects are refused, the response body is never read, and
 * failures schedule the next attempt with exponential backoff until the
 * delivery lands in dead_letter. Every state change is persisted and metricized.
 */

export type DeliveryOutcome = "succeeded" | "retry_scheduled" | "dead_letter" | "skipped";

export async function processWebhookDelivery(deliveryId: string): Promise<DeliveryOutcome> {
  const config = getConfig();
  const delivery = getWebhookDeliveryById(deliveryId);
  if (!delivery) return "skipped";
  if (delivery.status === "succeeded" || delivery.status === "dead_letter") return "skipped";
  const webhook = getWebhookById(delivery.organization_id, delivery.webhook_id);
  if (!webhook || !webhook.active) {
    updateWebhookDelivery(delivery.id, { status: "dead_letter", last_error: "Webhook removed or disabled.", next_attempt_at: null });
    return "dead_letter";
  }

  const verdict = await validateWebhookDestination(webhook.url);
  if (!verdict.ok || !verdict.url) {
    // A destination that became private/unresolvable never gets retried blindly:
    // it burns an attempt and follows normal backoff.
    return recordFailure(delivery.id, delivery.attempts, null, `Destination rejected: ${verdict.reason ?? "unavailable"}`);
  }

  const timestamp = Date.now();
  const body = delivery.payload_json;
  const signature = signWebhookPayload(webhook.secret, timestamp, delivery.event_id, body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.webhooks.timeoutMs);
  let statusCode: number | null = null;
  let networkError: string | null = null;
  try {
    const response = await fetch(verdict.url, {
      method: "POST",
      redirect: "error", // never follow redirects: they can bounce to internal hosts
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "ExtensionLab-Webhooks/1.0",
        "x-extensionlab-signature": signature,
        "x-extensionlab-event": delivery.event_type,
        "x-extensionlab-event-id": delivery.event_id,
        "x-extensionlab-delivery": delivery.id,
      },
      body,
    });
    statusCode = response.status;
    // The response body is deliberately never read (response-size safety).
  } catch (error) {
    networkError = error instanceof AppError ? "delivery_error" : controller.signal.aborted ? "timeout" : "network_error";
  } finally {
    clearTimeout(timeout);
  }

  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    updateWebhookDelivery(delivery.id, { status: "succeeded", attempts: delivery.attempts + 1, last_status_code: statusCode, last_error: null, next_attempt_at: null });
    recordMetric("webhook.delivery", 1, { result: "succeeded" });
    logger.info("webhook.delivered", { deliveryId: delivery.id, organizationId: delivery.organization_id, attempts: delivery.attempts + 1, statusCode });
    return "succeeded";
  }
  const detail = networkError ?? `HTTP ${statusCode ?? "unknown"}`;
  return recordFailure(delivery.id, delivery.attempts, statusCode, detail);
}

function recordFailure(deliveryId: string, attempts: number, statusCode: number | null, detail: string): DeliveryOutcome {
  const config = getConfig();
  const nextAttempts = attempts + 1;
  if (nextAttempts > config.webhooks.maxRetries + 1) {
    updateWebhookDelivery(deliveryId, { status: "dead_letter", attempts: nextAttempts, last_status_code: statusCode, last_error: detail.slice(0, 200), next_attempt_at: null });
    recordMetric("webhook.delivery", 1, { result: "dead_letter" });
    logger.warn("webhook.dead_letter", { deliveryId, attempts: nextAttempts });
    return "dead_letter";
  }
  const backoffMs = Math.min(config.webhooks.backoffBaseMs * 2 ** Math.max(0, nextAttempts - 1), 60 * 60 * 1000);
  const nextAttemptAt = Date.now() + backoffMs;
  updateWebhookDelivery(deliveryId, { status: "failed", attempts: nextAttempts, last_status_code: statusCode, last_error: detail.slice(0, 200), next_attempt_at: nextAttemptAt });
  enqueueJob({
    type: "WEBHOOK_DELIVERY",
    userId: null,
    organizationId: getWebhookDeliveryById(deliveryId)?.organization_id ?? null,
    payload: { deliveryId },
    idempotencyKey: `webhook-delivery-retry:${deliveryId}:${nextAttempts}`,
    resourceType: "webhook_delivery",
    resourceId: deliveryId,
    runAfter: nextAttemptAt,
    skipBackpressure: true,
    maxAttempts: 1,
  });
  recordMetric("webhook.delivery", 1, { result: "retry_scheduled" });
  logger.info("webhook.retry_scheduled", { deliveryId, attempts: nextAttempts, nextAttemptAt });
  return "retry_scheduled";
}


/** Due-delivery sweep (called by the cleanup scheduler). */
export async function sweepDueWebhookDeliveries(limit = 25): Promise<number> {
  const { listPendingWebhookDeliveries } = await import("@/lib/organizations/repository");
  const due = listPendingWebhookDeliveries(Date.now(), limit);
  for (const delivery of due) {
    if (delivery.status === "pending" || (delivery.status === "failed" && (delivery.next_attempt_at ?? 0) <= Date.now())) {
      await processWebhookDelivery(delivery.id);
    }
  }
  return due.length;
}
