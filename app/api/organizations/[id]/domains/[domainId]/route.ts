import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { deleteDomainRow } from "@/lib/organizations/repository";
import { recordAuditEvent } from "@/lib/audit/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; domainId: string }> };

/** DELETE — remove a verified or pending domain. */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, domainId } = await context.params;
    authorizeOrgAction(id, user.id, "org:domains:manage");
    if (deleteDomainRow(id, domainId)) {
      recordAuditEvent({ organizationId: id, actorUserId: user.id, action: "domain.removed", resourceType: "domain", resourceId: domainId });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
