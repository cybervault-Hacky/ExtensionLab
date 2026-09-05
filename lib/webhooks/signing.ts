import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook payload signing (Phase 10).
 *
 * Each webhook has its own secret (`whsec_…`), shown once at creation. The
 * signature is a modern HMAC construction over
 * `timestamp + "." + eventId + "." + rawBody` and is sent as:
 *
 *   X-ExtensionLab-Signature: t=<unix ts>,e=<event id>,v1=<hex hmac>
 *   X-ExtensionLab-Event:     <event type>
 *
 * Customers verify by recomputing the HMAC and comparing constantly, and by
 * rejecting timestamps outside their tolerance window (replay protection).
 */

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function signWebhookPayload(secret: string, timestamp: number, eventId: string, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${eventId}.${body}`).digest("hex");
  return `t=${timestamp},e=${eventId},v1=${mac}`;
}

/** Constant-time verification helper for customer-side verification tests. */
export function verifyWebhookSignature(secret: string, timestamp: number, eventId: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, timestamp, eventId, body), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
