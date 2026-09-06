import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { getSessionEventViews } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Durable structured session events (lifecycle + observed evidence). */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");
    const afterSeqRaw = new URL(request.url).searchParams.get("afterSeq");
    const afterSeq = afterSeqRaw && /^\d+$/.test(afterSeqRaw) ? Number(afterSeqRaw) : 0;
    return NextResponse.json({ events: getSessionEventViews(user.id, id, afterSeq) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
