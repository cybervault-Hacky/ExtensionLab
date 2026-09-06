import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { sendInput } from "@/lib/interactive/service";
import { inputPayloadWithinLimit } from "@/lib/interactive/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One typed, allowlisted input action per request (pointer/keyboard/scroll).
 * Coordinates, text length, key names and payload size are validated against
 * the session viewport and deployment limits; a per-session action-rate limit
 * applies. No arbitrary CDP payloads exist on this path.
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

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    if (!body || !body.action || typeof body.action !== "object") {
      throw badRequest("An input action is required.");
    }
    if (!inputPayloadWithinLimit(body)) {
      throw badRequest("The input payload is too large.");
    }
    await sendInput(user.id, id, body.action);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
