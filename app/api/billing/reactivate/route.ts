import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, rateLimited, requestIdFrom, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { reactivateSubscription } from "@/lib/billing/billing-service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/billing/reactivate — undo a scheduled cancellation. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const limit = await enforceRateLimitAsync("billingChange", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const billing = await reactivateSubscription(user, requestIdFrom(request));
    return NextResponse.json({ billing }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
