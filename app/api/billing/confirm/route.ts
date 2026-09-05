import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, rateLimited, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { buildBillingState, confirmCheckout } from "@/lib/billing/billing-service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/billing/confirm { sessionId } → { status, billing }
 * Polled by the checkout return page. It only consults the provider about a
 * session this user created; the URL parameter alone never grants anything.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const limit = enforceRateLimit("billingRead", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.sessionId !== "string") throw badRequest("Missing checkout session.");
    const result = await confirmCheckout(user, body.sessionId);
    return NextResponse.json({ status: result.status, billing: buildBillingState(user.id) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
