import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getSandboxConfig } from "./config";

/**
 * Safe URL policy for the Phase 3 tester.
 *
 * The sandbox must never become an unrestricted SSRF proxy. By default we
 * allow public web URLs only and block loopback, private, link-local, and
 * cloud-metadata addresses.
 */

function isPrivateIPv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80") ||
    normalized.startsWith("2001:db8")
  );
}

function hostnameIsLiteralPrivate(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const version = isIP(normalized);
  if (version === 4) return isPrivateIPv4(normalized);
  if (version === 6) return isPrivateIPv6(normalized);
  return false;
}

export interface UrlValidationResult {
  ok: boolean;
  url?: string;
  reason?: string;
  blockedReason?: string;
}

export function validateTestUrl(value: string): UrlValidationResult {
  if (value.trim() === "") {
    return { ok: true, url: undefined };
  }

  const config = getSandboxConfig();
  if (value.length > config.maxUrlLength) {
    return {
      ok: false,
      reason: "The URL is too long.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return {
      ok: false,
      reason: "This does not look like a valid absolute URL.",
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: "URLs with embedded credentials are not supported.",
    };
  }

  if (parsed.protocol === "http:" && !config.allowHttp) {
    return {
      ok: false,
      reason: "Plain HTTP is blocked. Please use HTTPS.",
    };
  }

  if (!config.allowedSchemes.includes(parsed.protocol as "https:" | "http:")) {
    return {
      ok: false,
      reason: "Only HTTPS and (when enabled) HTTP URLs are allowed.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (hostnameIsLiteralPrivate(host)) {
    return {
      ok: false,
      blockedReason: "This URL points to a private, local, or internal address.",
      reason: "This URL cannot be tested from the sandbox.",
    };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * Resolve DNS and reject hostnames that resolve to blocked ranges.
 *
 * The lookup is performed by the backend so a malicious extension cannot use
 * DNS rebinding to reach internal services.
 */
export async function validateTestUrlWithDns(
  value: string,
): Promise<UrlValidationResult> {
  const basic = validateTestUrl(value);
  if (!basic.ok || !basic.url) return basic;

  const parsed = new URL(basic.url);
  const host = parsed.hostname;
  if (isIP(host)) return basic;

  try {
    const addresses = await lookup(host, { all: true });
    const blocked = addresses.find((record) => {
      if (record.family === 4) return isPrivateIPv4(record.address);
      return isPrivateIPv6(record.address);
    });
    if (blocked) {
      return {
        ok: false,
        blockedReason: "The hostname resolves to a private or internal address.",
        reason: "This URL cannot be tested from the sandbox.",
      };
    }
  } catch {
    return {
      ok: false,
      reason: "The hostname could not be resolved.",
    };
  }

  return basic;
}
