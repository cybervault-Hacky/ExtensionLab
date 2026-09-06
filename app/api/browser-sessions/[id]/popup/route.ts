import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { closePopup, openPopup, toSessionView } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Opens or closes the real extension popup. The popup document is rendered
 * by the isolated browser as a genuine extension page; the host only relays
 * the allowlisted open/close commands and the resulting frames.
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

    const body = (await request.json().catch(() => null)) as { op?: unknown } | null;
    if (body?.op === "open") {
      const row = await openPopup(user.id, id);
      return NextResponse.json({ session: toSessionView(row) });
    }
    if (body?.op === "close") {
      const row = await closePopup(user.id, id);
      return NextResponse.json({ session: toSessionView(row) });
    }
    throw badRequest("Expected {op:\"open\"} or {op:\"close\"}.");
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
