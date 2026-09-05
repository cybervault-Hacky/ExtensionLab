import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * UX-only redirect: users without a session cookie are sent to sign in with the
 * original destination preserved. Real authentication and ownership are always
 * enforced server-side in the dashboard layout and API routes; a present cookie
 * is never treated as proof of a valid session.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasCookie = request.cookies.has("extensionlab_session");
  if (!hasCookie) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
