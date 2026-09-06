import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError, apiErrorResponse, assertEntitled, badRequest, requestIdFrom, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { canUseAI, getEffectivePlan } from "@/lib/billing/entitlements";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { withLogContext } from "@/lib/observability/logger";
import { isAIEnabled } from "@/lib/ai/provider";
import { isSafeId } from "@/lib/auth/validation";
import { explainSessionError } from "@/lib/interactive/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Explain Error with AI" (Phase 12): optional explanation layer over a
 * console/runtime error from this session. AI receives a minimized, redacted,
 * bounded projection; it can never control the browser or verify anything.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = requestIdFrom(request);
  return withLogContext({ requestId }, async () => {
    try {
      requireSameOrigin(request);
      const user = requireApiUser(request);
      const { id } = await context.params;
      if (!isSafeId(id)) throw badRequest("Invalid session id.");
      const rate = await enforceRateLimitAsync("aiRequest", `${user.id}:${getClientIp(request)}`);
      if (!rate.ok) throw new ApiError(429, "rate_limited", "Too many AI requests. Please slow down.");
      if (!isAIEnabled()) throw badRequest("AI assistance is not configured on this deployment.");
      const entitlement = canUseAI(user.id);
      if (!entitlement.allowed && entitlement.reason === "plan") {
        assertEntitled(entitlement, getEffectivePlan(user.id).plan.id);
      }
      const body = (await request.json().catch(() => ({}))) as { entryId?: unknown };
      const entryId = typeof body.entryId === "string" ? body.entryId.slice(0, 120) : null;
      const result = await explainSessionError(requestId, user.id, id, entryId);
      return NextResponse.json(result, { headers: { "x-request-id": requestId } });
    } catch (error) {
      return apiErrorResponse(error, request);
    }
  });
}
