import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { resendInvitation, revokeInvitation } from "@/lib/organizations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; invitationId: string }> };

/** POST — resend (rotates the token, resets expiry, one-time link returned). */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, invitationId } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:invitations:manage");
    const created = resendInvitation(ctx, id, invitationId);
    return NextResponse.json({ invitation: { id: created.id, expiresAt: created.expiresAt }, inviteUrl: `/invite/${created.token}` });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** DELETE — revoke before acceptance. */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, invitationId } = await context.params;
    if (!invitationId) throw badRequest("Invitation id required.");
    const ctx = authorizeOrgAction(id, user.id, "org:invitations:manage");
    revokeInvitation(ctx, id, invitationId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
