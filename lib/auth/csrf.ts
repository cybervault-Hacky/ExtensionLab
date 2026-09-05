import type { NextRequest } from "next/server";

/**
 * Defense-in-depth CSRF check on top of SameSite=Lax cookies.
 *
 * State-changing, cookie-authenticated requests must originate from the same
 * site. Requests without an Origin header (curl, same-origin server clients)
 * are accepted because they cannot be cross-site browser forms without an
 * Origin/Referer header in modern browsers.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const requestHost = request.headers.get("host");
    const originUrl = new URL(origin);
    if (!requestHost) return false;
    const hostname = originUrl.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return originUrl.port ? `${hostname}:${originUrl.port}` === requestHost : hostname === requestHost || `localhost:${originUrl.port}` === requestHost;
    }
    return originUrl.host === requestHost;
  } catch {
    return false;
  }
}
