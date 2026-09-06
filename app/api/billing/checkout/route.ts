import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, rateLimited, requestIdFrom, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { startCheckout } from "@/lib/billing/billing-service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/billing/checkout { planId } → { url, checkout? }
 * The client names a plan; the server resolves the configured price. Any
 * price/amount/currency in the body is ignored. For redirect providers the
 * browser goes to `url`; for popup providers (Razorpay) it also receives a
 * safe checkout config containing only public values (key id + subscription
 * reference) — never a secret, never a client-chosen amount.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const limit = await enforceRateLimitAsync("billingCheckout", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.planId !== "string") throw badRequest("Choose a plan to continue.");
    const result = await startCheckout(user, body.planId, requestIdFrom(request));
    return NextResponse.json(
      { url: result.url, reused: result.reused, ...(result.checkout ? { checkout: result.checkout } : {}) },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
