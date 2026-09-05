import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { getOrganizationPolicyRules, updateOrganizationPolicy } from "@/lib/policies/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET — the organization's CI quality gates (any member). */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    authorizeOrgAction(id, user.id, "org:read");
    return NextResponse.json({ policy: getOrganizationPolicyRules(id) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** PUT — replace the quality gates (developer+, audited, normalized). */
export async function PUT(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    authorizeOrgAction(id, user.id, "org:policy:manage");
    const body = (await request.json().catch(() => null)) as { rules?: unknown; name?: unknown } | null;
    const rules = updateOrganizationPolicy({ userId: user.id, organizationId: id }, body?.rules ?? {}, typeof body?.name === "string" ? body.name : undefined);
    return NextResponse.json({ policy: rules });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
