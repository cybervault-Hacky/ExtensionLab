import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError, apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { getConfig } from "@/lib/config/env";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { keepaliveSession, toSessionView } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated keepalive: refreshes last-activity (preventing the idle
 * timeout while the user is watching) but never extends the hard lifetime
 * deadline. Rate-limited per user+session.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");
    const limit = getConfig().interactiveBrowser.keepalivePerMinute;
    const rate = checkRateLimit(`ibrowser-keepalive:${user.id}:${id}`, limit, 60_000);
    if (!rate.ok) {
      throw new ApiError(429, "rate_limited", "Keepalive requests are too frequent.");
    }
    const row = keepaliveSession(user.id, id);
    return NextResponse.json({ session: toSessionView(row) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
