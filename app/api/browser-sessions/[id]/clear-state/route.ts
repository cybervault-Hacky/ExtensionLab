import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { clearBrowserStateSession, toSessionView } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clear Browser State (Phase 12): clears cookies/storage of THIS disposable
 * container browser only. ExtensionLab data and the user's real browser are
 * unreachable by construction. The UI asks for confirmation first.
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
    const row = await clearBrowserStateSession(user.id, id);
    return NextResponse.json({ session: toSessionView(row) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
