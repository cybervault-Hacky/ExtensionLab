import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import {
  changeMemberRole,
  inviteMember,
  leaveOrganization,
  listOrganizationInvitations,
  listOrganizationMembers,
  removeOrganizationMember,
  resendInvitation,
  transferOwnership,
} from "@/lib/organizations/service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET — member list + open invitations (members:read). */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:members:read");
    return NextResponse.json({
      ...listOrganizationMembers(ctx, id),
      invitations: listOrganizationInvitations(ctx, id),
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST — invite a member (admin+). */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:invitations:manage");
    const body = (await request.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
    if (!body || typeof body.email !== "string" || typeof body.role !== "string") throw badRequest("Email and role are required.");
    const created = inviteMember(ctx, id, { email: body.email, role: body.role });
    return NextResponse.json(
      {
        invitation: { id: created.id, email: created.email, role: created.role, expiresAt: created.expiresAt },
        // The one-time invitation link is shown exactly once, to the inviter.
        inviteUrl: `/invite/${created.token}`,
      },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** PATCH — change a member role, transfer ownership, or resend an invitation. */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as { targetUserId?: unknown; role?: unknown; transferOwnership?: unknown; invitationId?: unknown } | null;
    if (!body) throw badRequest("A body is required.");
    if (typeof body.invitationId === "string") {
      const ctx = authorizeOrgAction(id, user.id, "org:invitations:manage");
      const created = resendInvitation(ctx, id, body.invitationId);
      return NextResponse.json({ invitation: { id: created.id, expiresAt: created.expiresAt }, inviteUrl: `/invite/${created.token}` });
    }
    if (typeof body.targetUserId !== "string") throw badRequest("targetUserId is required.");
    if (body.transferOwnership === true) {
      const ctx = authorizeOrgAction(id, user.id, "org:ownership:transfer");
      transferOwnership(ctx, id, body.targetUserId);
      return NextResponse.json({ ok: true });
    }
    if (typeof body.role !== "string") throw badRequest("role is required.");
    const ctx = authorizeOrgAction(id, user.id, "org:role:change");
    const member = changeMemberRole(ctx, id, body.targetUserId, body.role);
    return NextResponse.json({ member });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** DELETE — remove a member (?userId=) or leave the organization (no param). */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const target = new URL(request.url).searchParams.get("userId");
    if (!target) {
      const ctx = authorizeOrgAction(id, user.id, "org:read");
      leaveOrganization(ctx, id);
      return NextResponse.json({ ok: true });
    }
    const ctx = authorizeOrgAction(id, user.id, "org:members:manage");
    removeOrganizationMember(ctx, id, target);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
