import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, rateLimited, requestIdFrom, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { createPortalUrl } from "@/lib/billing/billing-service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/billing/portal → { url } (hosted provider billing portal). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const limit = await enforceRateLimitAsync("billingPortal", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const url = await createPortalUrl(user, requestIdFrom(request));
    return NextResponse.json({ url }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
