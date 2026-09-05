import { redactSensitiveText, redactUrlShallow } from "@/lib/runtime/redact";

/**
 * Redaction applied to *every* string before it becomes part of an AI
 * context. This builds on the Phase 3 runtime redaction (query parameters,
 * bearer tokens) and adds credential shapes that appear in extension source,
 * manifests, console output and stack traces.
 *
 * The goal is data minimization, not perfect secret detection: strings that
 * look like credentials are replaced with a typed placeholder so the model
 * still understands *that* a credential was present without seeing it.
 */

const PLACEHOLDER = "[REDACTED]";

interface Rule {
  pattern: RegExp;
  replace: string | ((...groups: string[]) => string);
}

// Order matters: specific tokens first, then generic key=value shapes.
const RULES: Rule[] = [
  // Stripe / payment provider secrets and restricted keys, webhook secrets.
  { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, replace: "[REDACTED_API_KEY]" },
  { pattern: /\bwhsec_[A-Za-z0-9]{6,}\b/g, replace: "[REDACTED_WEBHOOK_SECRET]" },
  // OpenAI-style, GitHub, Slack, Google, AWS access keys.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: "[REDACTED_API_KEY]" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_TOKEN]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: "[REDACTED_TOKEN]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[REDACTED_TOKEN]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: "[REDACTED_API_KEY]" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  // JWTs (three base64url segments, first one starts with eyJ).
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: "[REDACTED_JWT]" },
  // PEM blocks.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[REDACTED_PRIVATE_KEY]" },
  // HTTP credentials in headers / header-like strings.
  { pattern: /\b(authorization|proxy-authorization)\s*[:=]\s*["']?[^"'\r\n]+/gi, replace: (_m, name: string) => `${name}: ${PLACEHOLDER}` },
  { pattern: /\b(cookie|set-cookie)\s*[:=]\s*["']?[^"'\r\n]+/gi, replace: (_m, name: string) => `${name}: ${PLACEHOLDER}` },
  { pattern: /\b(x-api-key|x-auth-token|api-key)\s*[:=]\s*["']?[^"'\s]+/gi, replace: (_m, name: string) => `${name}: ${PLACEHOLDER}` },
  { pattern: /\b(basic)\s+[A-Za-z0-9+/=]{12,}/gi, replace: (_m, scheme: string) => `${scheme} ${PLACEHOLDER}` },
  // document.cookie / cookie strings with session-like names.
  { pattern: /\b(session(?:_?id)?|sid|csrf(?:_?token)?|xsrf(?:_?token)?|remember_?me)=([^;\s"']+)/gi, replace: (_m, name: string) => `${name}=${PLACEHOLDER}` },
  // Environment-style assignments: SOME_SECRET=value, API_KEY: "value", PASSWORD=value.
  {
    pattern: /\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH|SIGNATURE|PRIVATE)[A-Z0-9_]*)\s*[:=]\s*["']?[^"'\s,;]+/g,
    replace: (_m, name: string) => `${name}=${PLACEHOLDER}`,
  },
  // Lower/mixed-case unquoted assignments in free text: password=..., token: ..., apiKey = ...
  {
    pattern: /\b(password|passwd|passphrase|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token)\s*[:=]\s*[^\s"'`&;,]+/gi,
    replace: (_m, name: string) => `${name}=${PLACEHOLDER}`,
  },
  // JSON / JS object keys and assignments: "apiKey": "...", password = '...'.
  {
    pattern: /(["']?)(api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|pwd|private[_-]?key|webhook[_-]?secret|signing[_-]?secret)\1\s*[:=]\s*(["'`])[^"'`]*\3/gi,
    replace: (_m, q: string, name: string, q2: string) => `${q}${name}${q}: ${q2}${PLACEHOLDER}${q2}`,
  },
  // password=... in free text / URLs handled by redactSensitiveText; also redact "password <value>" phrases.
  { pattern: /\b(password|passwd|passphrase)\s+is\s+\S+/gi, replace: (_m, name: string) => `${name} is ${PLACEHOLDER}` },
  // Email addresses (account data never needs to reach the provider).
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: "[REDACTED_EMAIL]" },
  // Long opaque hex/base64 blobs (hashes, tokens) — keep short ids intact.
  { pattern: /\b[A-Fa-f0-9]{40,}\b/g, replace: "[REDACTED_HEX]" },
  { pattern: /\b[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/=])/g, replace: "[REDACTED_BLOB]" },
];

/** Redacts one string. Idempotent; safe on already-redacted input. */
export function redactForAI(value: string): string {
  if (!value) return value;
  let out = redactSensitiveText(value);
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as string);
  }
  return out;
}

/** URLs: strip credentials/query secrets, then apply the generic rules. */
export function redactUrlForAI(value: string): string {
  let url = value;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    url = parsed.toString();
  } catch {
    // Not an absolute URL; fall through to text redaction.
  }
  return redactForAI(redactUrlShallow(url));
}

/**
 * Walks a JSON-compatible value and redacts every string, including object
 * keys that look like secret names (their values are replaced wholesale).
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return "[TRUNCATED]" as unknown as T;
  if (typeof value === "string") return redactForAI(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? PLACEHOLDER : redactDeep(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

const SECRET_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|cookie|authorization|api[-_]?key|apikey|credential|session|private[-_]?key|signature|client[-_]?secret)/i;

/** True when a string still contains something that looks like a credential (used by tests and as a final guard). */
export function looksLikeSecret(value: string): boolean {
  return (
    /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/.test(value) ||
    /\bwhsec_[A-Za-z0-9]{6,}\b/.test(value) ||
    /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value) ||
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/.test(value) ||
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value) ||
    /bearer\s+[A-Za-z0-9._-]{8,}/i.test(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
  );
}
