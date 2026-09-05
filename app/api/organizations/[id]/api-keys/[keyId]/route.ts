import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { revokeApiKeyById } from "@/lib/api-keys/service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; keyId: string }> };

/** DELETE — revoke an API key (immediate, audited). */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, keyId } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:api-keys:manage");
    revokeApiKeyById({ userId: user.id, organizationId: id, ip: getClientIp(request) }, keyId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
