import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { reloadExtension, toSessionView } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reloads the bound extension. The server re-resolves the ORIGINAL immutable
 * package binding (ownership + SHA-256) before touching the browser; a
 * deleted or changed package fails closed with PACKAGE_UNAVAILABLE and ends
 * the session — a different package is never substituted.
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
    const row = await reloadExtension(user.id, id);
    return NextResponse.json({ session: toSessionView(row) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
