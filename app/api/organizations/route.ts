import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { createOrganization } from "@/lib/organizations/service";
import { getActiveWorkspace } from "@/lib/organizations/authorization";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/organizations — workspaces the signed-in user can switch between. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const workspace = await getActiveWorkspace(user.id);
    return NextResponse.json({
      active: workspace.kind === "organization" ? workspace.organization : null,
      kind: workspace.kind,
      options: workspace.options,
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST /api/organizations — create an organization (caller becomes owner). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const body = (await request.json().catch(() => null)) as { name?: unknown; slug?: unknown } | null;
    if (!body || typeof body.name !== "string") throw badRequest("An organization name is required.");
    const slug = typeof body.slug === "string" && body.slug.trim() !== "" ? body.slug.trim() : null;
    const organization = createOrganization(
      { userId: user.id, ip: getClientIp(request) },
      { name: body.name, ...(slug ? { slug } : {}) },
    );
    return NextResponse.json({ organization }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
