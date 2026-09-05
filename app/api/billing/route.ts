import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, rateLimited, requireApiUser } from "@/lib/auth/api";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { buildBillingState } from "@/lib/billing/billing-service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/billing — the signed-in user's billing state: effective plan,
 * subscription status, usage within the current billing period and the plan
 * catalog. Derived entirely from server-side state; never from the browser.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const limit = enforceRateLimit("billingRead", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    return NextResponse.json(buildBillingState(user.id), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
