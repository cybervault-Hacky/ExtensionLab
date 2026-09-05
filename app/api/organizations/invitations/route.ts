import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { acceptInvitation } from "@/lib/organizations/service";
import { listOpenInvitationsForEmail } from "@/lib/organizations/repository";
import { normalizeEmail } from "@/lib/auth/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — pending invitations addressed to the signed-in user's email. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const invitations = listOpenInvitationsForEmail(normalizeEmail(user.email));
    // Deliberately minimal: organization identity only, never the inviter.
    return NextResponse.json({
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        organizationId: invitation.organization_id,
        organizationName: invitation.organization_name,
        organizationSlug: invitation.organization_slug,
        role: invitation.role,
        expiresAt: invitation.expires_at,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST — accept an invitation with its one-time token. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
    if (!body || typeof body.token !== "string" || body.token.length < 20) throw badRequest("A valid invitation token is required.");
    const result = acceptInvitation({ userId: user.id, ip: null }, { token: body.token, email: normalizeEmail(user.email) });
    return NextResponse.json({ organizationId: result.organizationId, organizationName: result.organizationName });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
