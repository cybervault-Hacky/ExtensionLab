import "server-only";
import type { JobHandler } from "../types";
import { processWebhookDelivery } from "@/lib/webhooks/deliver";

/**
 * WEBHOOK_DELIVERY handler: executes exactly one delivery attempt. Retries are
 * scheduled as new jobs with backoff by the delivery state machine, so job
 * retries stay reserved for infrastructure failures.
 */
export function createWebhookDeliveryHandler(): JobHandler<"WEBHOOK_DELIVERY"> {
  return {
    type: "WEBHOOK_DELIVERY",
    async handle(context) {
      const outcome = await processWebhookDelivery(context.payload.deliveryId);
      return { outcome };
    },
    async cancel() {
      // Nothing to tear down: an attempt is a single bounded HTTP request.
    },
  };
}
