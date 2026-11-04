import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isControlledPublicPreview } from "@/lib/preview";
import { buildContentSecurityPolicy, generateNonce } from "@/lib/security/csp";

const PREVIEW_RESTRICTED_PREFIXES = [
  "/dashboard",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/report",
  "/extensions",
] as const;

function isPreviewRestrictedPage(pathname: string): boolean {
  return PREVIEW_RESTRICTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Edge middleware:
 *
 * 1. In controlled-preview mode, rejects every infrastructure-dependent API
 *    call before a route can touch local disk or an unconfigured dependency,
 *    and redirects account/workspace routes to an honest unavailable page.
 * 2. Issues a per-request CSP nonce for every HTML page. Next.js reads the
 *    nonce from the request's Content-Security-Policy header and applies it to
 *    its own inline scripts.
 * 3. Propagates/creates an X-Request-ID so logs and error references can be
 *    correlated across web, worker and reverse proxy.
 * 4. UX-only redirect: users without a session cookie are sent to sign in with
 *    the original destination preserved. Real authentication and ownership are
 *    always enforced server-side in the dashboard layout and API routes; a
 *    present cookie is never treated as proof of a valid session.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const controlledPreview = isControlledPublicPreview();

  // APIs were deliberately excluded from the regular CSP/nonce path. In a
  // controlled preview this must happen before route execution, otherwise a
  // request could initialize the development SQLite/local-storage fallback.
  if (pathname.startsWith("/api/")) {
    if (controlledPreview && pathname !== "/api/health") {
      return NextResponse.json(
        {
          error: {
            errorCode: "PREVIEW_FEATURE_UNAVAILABLE",
            message: "This controlled public preview does not provide persistent accounts, cloud APIs, uploads, AI assistance, payments, or browser testing.",
          },
        },
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
          },
        },
      );
    }
    return NextResponse.next();
  }

  if (controlledPreview && isPreviewRestrictedPage(pathname)) {
    return NextResponse.redirect(new URL("/preview-unavailable", request.url));
  }

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
    // Phase 14: Razorpay Standard Checkout origins. Inlined at build time
    // (Edge middleware); see lib/security/csp.ts and docs/RAZORPAY.md.
    razorpayCheckout: process.env.BILLING_PROVIDER === "razorpay" || process.env.CSP_RAZORPAY === "1",
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
    "/api/:path*",
    {
      // HTML pages receive CSP and an X-Request-ID. Static assets need none.
      // Prefetch requests carry no HTML, so skip them.
      source: "/((?!api|_next/static|_next/image|icons|favicon.ico|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
