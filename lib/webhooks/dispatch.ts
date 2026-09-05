import "server-only";
import { getDb } from "@/lib/db/client";
import { enqueueJob } from "@/lib/jobs/queue";
import { classifyError } from "@/lib/observability/errors";
import { generateEventId } from "@/lib/runtime/ids";
import { logger, recordMetric } from "@/lib/observability/logger";
import { insertWebhookDeliveryRow, listActiveWebhooksForEvent } from "@/lib/organizations/repository";

/**
 * Organization webhook dispatch (Phase 10).
 *
 * Business flows call `dispatchOrganizationEvent`; deliveries are persisted
 * first (audit trail) and executed by the WEBHOOK_DELIVERY job so retries,
 * backoff and dead-lettering are durable and observable.
 */

export const WEBHOOK_EVENTS = [
  "package.created",
  "test_run.created",
  "browser_matrix.created",
  "analysis.completed",
  "analysis.failed",
  "test_run.completed",
  "test_run.failed",
  "browser_matrix.completed",
  "browser_matrix.failed",
  "regression.detected",
  "report.created",
  "member.joined",
  "export.completed",
  "export.failed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  createdAt: number;
  organizationId: string;
  data: Record<string, unknown>;
}

/**
 * Emits an organization event to every subscribed active webhook. Payloads are
 * metadata only (ids, statuses, scores) — never source code, secrets or
 * infrastructure details.
 */
export function dispatchOrganizationEvent(organizationId: string, eventType: WebhookEventType, data: Record<string, unknown>): string | null {
  try {
    return dispatchOrganizationEventUnsafe(organizationId, eventType, data);
  } catch (error) {
    // Webhook fan-out must never break the business flow that emitted it.
    logger.warn("webhook.dispatch_failed", { organizationId, eventType, errorCode: classifyError(error).code });
    return null;
  }
}

function dispatchOrganizationEventUnsafe(organizationId: string, eventType: WebhookEventType, data: Record<string, unknown>): string | null {
  const webhooks = listActiveWebhooksForEvent(organizationId, eventType);
  if (webhooks.length === 0) return null;
  const event: WebhookEvent = {
    id: `evt_${generateEventId().replace(/^evt_/, "")}_${Date.now().toString(36)}`,
    type: eventType,
    createdAt: Date.now(),
    organizationId,
    data,
  };
  const payload = JSON.stringify({
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    organization: { id: organizationId },
    data,
  });
  for (const webhook of webhooks) {
    const delivery = insertWebhookDeliveryRow({
      organizationId,
      webhookId: webhook.id,
      eventId: event.id,
      eventType,
      payloadJson: payload,
    });
    enqueueJob({
      type: "WEBHOOK_DELIVERY",
      userId: null,
      organizationId,
      payload: { deliveryId: delivery.id },
      idempotencyKey: `webhook-delivery:${delivery.id}`,
      resourceType: "webhook_delivery",
      resourceId: delivery.id,
      skipBackpressure: true,
      maxAttempts: 1, // retries are managed by the delivery state machine
    });
  }
  recordMetric("webhook.event_dispatched", 1, { type: eventType });
  logger.info("webhook.dispatched", { organizationId, eventType, eventId: event.id, deliveries: webhooks.length });
  return event.id;
}

export function pendingDeliveryDueCount(now = Date.now()): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM organization_webhook_deliveries WHERE status IN ('pending','failed') AND next_attempt_at <= ?")
    .get(now) as { n: number };
  return Number(row.n);
}
