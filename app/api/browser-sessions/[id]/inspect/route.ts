import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { inspectSessionElement } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe element inspection (Phase 12): bounded metadata gathered by the FIXED
 * in-container script. Coordinates are viewport-validated here AND inside the
 * runner; the response carries no HTML dump and no secrets (password values
 * are redacted in-container and again on the host).
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
    const body = (await request.json().catch(() => null)) as { x?: unknown; y?: unknown; target?: unknown } | null;
    if (!body) throw badRequest("Inspection coordinates are required.");
    const inspection = await inspectSessionElement(user.id, id, body.x, body.y, body.target);
    return NextResponse.json({ inspection });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
