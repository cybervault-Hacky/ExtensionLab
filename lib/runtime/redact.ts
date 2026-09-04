/**
 * Runtime redaction utilities.
 *
 * ExtensionLab never persists or exposes credentials in runtime network data.
 * Sensitive query parameters, request headers, cookies, and authentication
 * data are redacted before they leave the sandbox runner.
 */

const SENSITIVE_PARAM_NAMES = [
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "session",
  "sig",
  "signature",
  "credential",
];

const SENSITIVE_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "api-key",
  "secret",
  "secret-key",
];

const SENSITIVE_PARAM_PATTERN = new RegExp(
  `(^|[?&])(${SENSITIVE_PARAM_NAMES.join("|")})=[^&]*`,
  "gi",
);

export function redactQueryParameters(value: string): string {
  return value.replace(
    SENSITIVE_PARAM_PATTERN,
    (_match, prefix: string, name: string) => `${prefix}${name}=REDACTED`,
  );
}

export function redactUrlShallow(value: string): string {
  if (value.length === 0) return value;
  const max = 512;
  const prefix = value.length > max ? value.slice(0, max) + "…" : value;
  return redactQueryParameters(prefix);
}

export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value])
      .filter(([name]) => !SENSITIVE_HEADER_NAMES.includes(name))
      .map(([name]) => [name, "[redacted]"]),
  );
}

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.includes(name.toLowerCase());
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      SENSITIVE_PARAM_PATTERN,
      (_match, prefix: string, name: string) => `${prefix}${name}=REDACTED`,
    )
    .replace(/(bearer\s+)[a-z0-9._\-]+/gi, "$1REDACTED");
}
