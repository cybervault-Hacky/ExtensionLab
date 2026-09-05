import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildContentSecurityPolicy, generateNonce } from "@/lib/security/csp";

/**
 * Edge middleware:
 *
 * 1. Issues a per-request CSP nonce for every HTML page. Next.js reads the
 *    nonce from the request's Content-Security-Policy header and applies it to
 *    its own inline scripts; `app/layout.tsx` reads it from `x-nonce`.
 * 2. Propagates/creates an `X-Request-ID` so logs and error references can be
 *    correlated across web, worker and reverse proxy.
 * 3. UX-only redirect: users without a session cookie are sent to sign in with
 *    the original destination preserved. Real authentication and ownership are
 *    always enforced server-side in the dashboard layout and API routes; a
 *    present cookie is never treated as proof of a valid session.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith("/dashboard") && !request.cookies.has("extensionlab_session")) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === "development",
    upgradeInsecureRequests: process.env.NODE_ENV === "production" && request.nextUrl.protocol === "https:",
  });

  const incomingRequestId = request.headers.get("x-request-id");
  const requestId = incomingRequestId && /^[A-Za-z0-9_.-]{6,64}$/.test(incomingRequestId) ? incomingRequestId : `req_${nonce.slice(0, 12)}`;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: [
    {
      // All pages; API routes get a static CSP from next.config.ts and static
      // assets need none. Prefetch requests carry no HTML, so skip them.
      source: "/((?!api|_next/static|_next/image|icons|favicon.ico|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
