import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { isBillingEnabled } from "@/lib/billing/provider";
import { BillingError } from "@/lib/billing/errors";
import { processProviderEvent, verifyWebhookRequest } from "@/lib/billing/webhooks";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric, resolveRequestId } from "@/lib/observability/logger";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * POST /api/billing/webhook — provider → app notifications.
 *
 * No session and no CSRF check (the provider is not a browser); authenticity
 * comes from the signature over the *raw* body. Responses:
 *   200 — processed, duplicate or ignored (the provider must not retry)
 *   400 — bad signature / malformed payload (retrying will not help)
 *   429 — rate limited (provider retries with backoff)
 *   500 — transient failure while applying the event (provider retries)
 * Bodies never include stack traces or provider payloads.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const headers = { "x-request-id": requestId, "cache-control": "no-store" };
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: { errorCode: "BILLING_NOT_CONFIGURED", requestId } }, { status: 404, headers });
  }
  const limit = enforceRateLimit("billingWebhook", getClientIp(request));
  if (!limit.ok) {
    recordMetric("billing.webhook_rate_limited", 1);
    return NextResponse.json({ error: { errorCode: "RATE_LIMITED", requestId } }, { status: 429, headers: { ...headers, "retry-after": String(limit.retryAfterSeconds) } });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { errorCode: "INVALID_INPUT", requestId } }, { status: 413, headers });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: { errorCode: "INVALID_INPUT", requestId } }, { status: 400, headers });
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { errorCode: "INVALID_INPUT", requestId } }, { status: 413, headers });
  }

  try {
    const event = verifyWebhookRequest(rawBody, request.headers);
    recordMetric("billing.webhook_received", 1, { type: event.type });
    const outcome = await processProviderEvent(event);
    return NextResponse.json({ received: true, outcome }, { status: 200, headers });
  } catch (error) {
    if (error instanceof BillingError && error.code === "WEBHOOK_SIGNATURE_INVALID") {
      recordMetric("billing.webhook_rejected", 1);
      logger.warn("billing.webhook_rejected", { component: "billing", requestId, errorCode: error.code, result: "error" });
      return NextResponse.json({ error: { errorCode: error.code, requestId } }, { status: 400, headers });
    }
    const errorCode = error instanceof AppError ? error.code : "INTERNAL";
    logger.error("billing.webhook_error", { component: "billing", requestId, errorCode, result: "error" });
    // 5xx → the provider retries; the event ledger guarantees at-most-once application.
    return NextResponse.json({ error: { errorCode: "INTERNAL", requestId } }, { status: 500, headers });
  }
}
