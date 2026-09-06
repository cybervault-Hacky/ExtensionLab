import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { setSessionViewport, toSessionView } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Viewport changes: allowlisted dimensions only (deployment bounds), applied
 * through the runner's set-viewport command and persisted in session state.
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

    const body = (await request.json().catch(() => null)) as { width?: unknown; height?: unknown } | null;
    if (!body || typeof body.width !== "number" || typeof body.height !== "number") {
      throw badRequest("Expected {width, height}.");
    }
    const row = await setSessionViewport(user.id, id, body.width, body.height);
    return NextResponse.json({ session: toSessionView(row) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
