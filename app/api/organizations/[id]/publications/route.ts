import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { listOrganizationPublications, publishReport } from "@/lib/reports/publications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET — published reports for the organization. */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    authorizeOrgAction(id, user.id, "org:resources:read");
    return NextResponse.json({ publications: listOrganizationPublications(id) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST — publish a report to a public slug (admin+). */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:publications:manage");
    const body = (await request.json().catch(() => null)) as { reportId?: unknown; slug?: unknown; summary?: unknown } | null;
    if (!body || typeof body.reportId !== "string" || typeof body.slug !== "string") throw badRequest("reportId and slug are required.");
    const publication = publishReport(ctx, {
      reportId: body.reportId,
      slug: body.slug,
      ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
    });
    return NextResponse.json({ publication, publicUrl: `/extensions/${publication.slug}` }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
