import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { getConsoleEntries } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Console ring (bounded, sanitized by the runner before it leaves the
 * container). Sensitive values are redacted upstream; the host adds nothing.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");
    return NextResponse.json(getConsoleEntries(user.id, id));
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
