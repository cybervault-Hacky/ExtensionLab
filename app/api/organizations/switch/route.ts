import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { WORKSPACE_COOKIE, getActiveWorkspace } from "@/lib/organizations/authorization";
import { getMembership } from "@/lib/organizations/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/organizations/switch — select the active workspace. The requested
 * id is validated against real memberships server-side; the cookie is only a
 * cached hint that every privileged read re-verifies.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const body = (await request.json().catch(() => null)) as { organizationId?: unknown } | null;
    const organizationId = body?.organizationId;
    let value = "personal";
    if (typeof organizationId === "string" && organizationId !== "personal") {
      if (!getMembership(organizationId, user.id)) throw badRequest("Workspace not available.");
      value = organizationId;
    }
    const response = NextResponse.json({ ok: true, workspace: value });
    response.cookies.set(WORKSPACE_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return response;
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** GET — current workspace (used by the switcher on load). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const workspace = await getActiveWorkspace(user.id);
    return NextResponse.json({ kind: workspace.kind, organizationId: workspace.organizationId, options: workspace.options });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
