import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getConfig } from "@/lib/config/env";
import { hostnameIsLiteralPrivate, isPrivateIPv4, isPrivateIPv6 } from "@/lib/runtime/urls";

/**
 * SSRF-safe webhook destination validation (Phase 10).
 *
 * Webhooks may only reach public HTTPS endpoints. Loopback, private, link-local
 * and cloud-metadata targets are blocked — at configuration time AND again at
 * every delivery attempt with a fresh DNS resolution (rebinding protection).
 * A private test allowance exists only when the whole process runs in the test
 * environment; production never exposes it.
 */

export interface DestinationVerdict {
  ok: boolean;
  url?: string;
  reason?: string;
}

const MAX_URL_LENGTH = 500;

export async function validateWebhookDestination(rawUrl: string): Promise<DestinationVerdict> {
  const config = getConfig();
  const value = rawUrl.trim();
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "The URL is missing or too long." };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "This does not look like a valid URL." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed." };
  }
  const allowHttp = config.appEnv === "test" && config.webhooks.allowPrivateInTest;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    return { ok: false, reason: "Only HTTPS webhook destinations are allowed." };
  }
  const host = parsed.hostname.toLowerCase().replace(/[\[\]]/g, "");
  const allowPrivate = config.appEnv === "test" && config.webhooks.allowPrivateInTest;
  if (!allowPrivate && hostnameIsLiteralPrivate(host)) {
    return { ok: false, reason: "This destination points to a private, local or internal address." };
  }
  if (isIP(host) === 0) {
    // Resolve now and at delivery time: a hostname that resolves into a
    // blocked range is rejected immediately.
    try {
      const addresses = await lookup(host, { all: true });
      if (!allowPrivate) {
        const blocked = addresses.find((record) => (record.family === 4 ? isPrivateIPv4(record.address) : isPrivateIPv6(record.address)));
        if (blocked) {
          return { ok: false, reason: "This destination resolves to a private or internal address." };
        }
      }
    } catch {
      return { ok: false, reason: "The destination hostname could not be resolved." };
    }
  }
  return { ok: true, url: parsed.toString() };
}
