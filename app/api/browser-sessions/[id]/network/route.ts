import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { getNetworkEntries } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Network ring (bounded, redacted): method, safe URL, status, resource type,
 * timestamp, duration. No request headers, cookies or bodies are captured.
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
    return NextResponse.json(getNetworkEntries(user.id, id));
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
