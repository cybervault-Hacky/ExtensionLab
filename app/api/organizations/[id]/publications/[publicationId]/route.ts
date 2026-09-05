import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { unpublishReport } from "@/lib/reports/publications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; publicationId: string }> };

/** DELETE — unpublish (the slug becomes unavailable immediately). */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, publicationId } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:publications:manage");
    unpublishReport(ctx, publicationId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
