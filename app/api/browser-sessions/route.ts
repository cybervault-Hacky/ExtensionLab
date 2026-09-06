import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/runtime/api-helpers";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  requestIdFrom,
  requireApiUser,
  requireSameOrigin,
} from "@/lib/auth/api";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { isSafeId } from "@/lib/auth/validation";
import { createInteractiveSession, toSessionView } from "@/lib/interactive/service";
import { listSessionsForUser } from "@/lib/db/repositories/browser-sessions";
import { withLogContext } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Interactive browser sessions (Phase 11).
 *
 * POST creates a session bound to one exact immutable package (ownership and
 * entitlements are verified server-side). GET lists the caller's sessions for
 * reconnection. Cross-tenant callers see nothing.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFrom(request);
  return withLogContext({ requestId }, async () => {
    try {
      requireSameOrigin(request);
      const user = requireApiUser(request);
      const rate = enforceRateLimit("browserSessionCreate", `${user.id}:${getClientIp(request)}`);
      if (!rate.ok) {
        throw new ApiError(429, "rate_limited", "Too many browser sessions created. Please wait a moment.");
      }

      const body = (await request.json().catch(() => null)) as {
        packageId?: unknown;
        initialUrl?: unknown;
        viewport?: { width?: unknown; height?: unknown };
      } | null;
      if (!body || typeof body.packageId !== "string" || !isSafeId(body.packageId)) {
        throw badRequest("A valid packageId is required.");
      }
      if (body.initialUrl !== undefined && body.initialUrl !== null && typeof body.initialUrl !== "string") {
        throw badRequest("initialUrl must be a string.");
      }
      const viewport =
        body.viewport && typeof body.viewport === "object"
          ? { width: body.viewport.width, height: body.viewport.height }
          : {};

      const row = createInteractiveSession(user, {
        userId: user.id,
        packageId: body.packageId,
        initialUrl: typeof body.initialUrl === "string" && body.initialUrl.trim() !== "" ? body.initialUrl : null,
        viewportWidth: typeof viewport.width === "number" ? viewport.width : undefined,
        viewportHeight: typeof viewport.height === "number" ? viewport.height : undefined,
        requestId,
      });
      return NextResponse.json({ session: toSessionView(row) }, { status: 201 });
    } catch (error) {
      return apiErrorResponse(error, request);
    }
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const sessions = listSessionsForUser(user.id, 20).map(toSessionView);
    return NextResponse.json({ sessions });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
