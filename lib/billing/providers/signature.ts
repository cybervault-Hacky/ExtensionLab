import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe-style webhook signatures (`Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`).
 *
 *   signed_payload = `${t}.${rawBody}`
 *   v1 = HMAC-SHA256(secret, signed_payload)
 *
 * The fake provider signs its deliveries the same way so the verification
 * path exercised by tests is byte-for-byte the production one.
 */

export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, rawBody: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

export type SignatureFailure = "missing" | "malformed" | "timestamp" | "mismatch";

export function verifySignature(input: {
  secret: string;
  rawBody: string;
  header: string | null;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): { ok: true } | { ok: false; reason: SignatureFailure } {
  if (!input.header) return { ok: false, reason: "missing" };
  const parts = input.header.split(",").map((part) => part.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "malformed" };

  const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "timestamp" };

  const expected = Buffer.from(
    createHmac("sha256", input.secret).update(`${timestamp}.${input.rawBody}`, "utf8").digest("hex"),
    "hex",
  );
  for (const candidate of signatures) {
    const actual = Buffer.from(candidate, "hex");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}
