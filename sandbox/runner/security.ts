import { isIP } from "node:net";

const SENSITIVE = /([?&])(token|access_token|id_token|refresh_token|api_key|apikey|key|secret|password|passwd|pwd|auth|authorization|session|sig|signature|credential)=[^&]*/gi;

export const DEFAULT_TEST_PAGE_URL = "http://127.0.0.1:8080/extensionlab-test";

function isPrivateIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
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

function privateIp(address: string): boolean {
  if (address.includes(":")) return isPrivateIPv6(address);
  return isPrivateIPv4(address);
}

export function validatePublicUrl(value: string): { ok: boolean; url: string; reason?: string } {
  if (value === DEFAULT_TEST_PAGE_URL) return { ok: true, url: value };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, url: value, reason: "Only HTTP/HTTPS URLs are supported." };
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      isIP(host) && privateIp(host)
    ) {
      return { ok: false, url: value, reason: "Private and internal URLs are blocked." };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, url: value, reason: "Invalid URL." };
  }
}

export function redactUrl(value: string): string {
  if (value.length > 512) return redactSensitive(value.slice(0, 512) + "…");
  return redactSensitive(value);
}

export function redactSensitive(value: string): string {
  return value.replace(SENSITIVE, "$1$2=REDACTED");
}

export function truncate(value: string, max = 2000): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

export function sanitizeText(value: string): string {
  return truncate(value.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 2000);
}
