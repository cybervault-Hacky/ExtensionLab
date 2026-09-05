import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { getSsoConfigView, removeSsoConfig, saveSsoConfig } from "@/lib/sso/service";
import { listDomains } from "@/lib/organizations/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET — SSO configuration (masked) + verified domains (owner only). */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    authorizeOrgAction(id, user.id, "org:sso:manage");
    const view = getSsoConfigView(id);
    view.enforcedDomains = listDomains(id).filter((domain) => domain.verified_at !== null).map((domain) => domain.domain);
    return NextResponse.json({ sso: view });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** PUT — create/update the SSO provider configuration (owner only). */
export async function PUT(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:sso:manage");
    const body = (await request.json().catch(() => ({}))) as { protocol?: unknown; status?: unknown; config?: unknown };
    const sso = saveSsoConfig(ctx, body);
    return NextResponse.json({ sso });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** DELETE — disable SSO for the organization. */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:sso:manage");
    removeSsoConfig(ctx);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
