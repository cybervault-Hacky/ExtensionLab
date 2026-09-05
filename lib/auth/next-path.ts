/**
 * Restricts post-auth redirects to same-origin, in-app paths. Anything that
 * could be interpreted as an external URL ("//host", "http:", backslashes)
 * falls back to the dashboard. Safe to use from client components.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\r\n\\]/.test(value) || /^\/[a-z]+:/i.test(value)) return fallback;
  return value;
}
