import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { getExportDownload, listExports, requestExport } from "@/lib/organizations/export";
import { AppError } from "@/lib/observability/errors";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { getStorage } from "@/lib/storage/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET — export history (?download=<exportId> streams the artifact). */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:exports:manage");
    const download = new URL(request.url).searchParams.get("download");
    if (download) {
      const artifact = getExportDownload(ctx, download);
      const bytes = artifact ? await getStorage().get(artifact.storageKey) : null;
      if (!bytes) throw new AppError("NOT_FOUND", { message: "Export not found or expired." });
      return new NextResponse(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="extensionlab-export-${download}.json"`,
          "cache-control": "no-store",
        },
      });
    }
    return NextResponse.json({ exports: listExports(ctx) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST — request a new async export (rate-limited inside the service). */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:exports:manage");
    const view = await requestExport({ userId: user.id, organizationId: id, ip: getClientIp(request) });
    return NextResponse.json({ export: view }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
