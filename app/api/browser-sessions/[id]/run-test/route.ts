import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { runTestFromSession } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run Test (Phase 12): enqueues the standard Phase 4 automated suite for the
 * session's bound package — the exact pipeline the dashboard uses. Quotas,
 * concurrency and billing behave identically to any other test run.
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
    const created = await runTestFromSession(user.id, id);
    return NextResponse.json({ runId: created.runId }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
