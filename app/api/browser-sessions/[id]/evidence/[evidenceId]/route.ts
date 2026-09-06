import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { removeSessionEvidence } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deletes evidence that is not attached to a report (Phase 12). */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; evidenceId: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, evidenceId } = await context.params;
    if (!isSafeId(id) || !isSafeId(evidenceId)) throw badRequest("Invalid id.");
    removeSessionEvidence(user.id, evidenceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
