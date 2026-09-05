import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { deleteOrganization, getOrganizationView, updateOrganizationProfile } from "@/lib/organizations/service";
import { getOrganizationEntitlements, seatUsage } from "@/lib/organizations/entitlements";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET — organization overview (any member). */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:read");
    const organization = getOrganizationView(ctx, id);
    return NextResponse.json({
      organization,
      seats: seatUsage(id),
      entitlements: getOrganizationEntitlements(id),
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** PATCH — rename (admin+). */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:settings:manage");
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    if (!body || typeof body.name !== "string") throw badRequest("A name is required.");
    const organization = updateOrganizationProfile(ctx, id, { name: body.name });
    return NextResponse.json({ organization });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** DELETE — owner only. */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:delete");
    deleteOrganization(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
