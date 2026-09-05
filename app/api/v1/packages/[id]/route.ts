import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getOrgPackage } from "@/lib/db/repositories/packages";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/packages/:id — package metadata for the API key's organization.
 * A package owned by any other organization is indistinguishable from a
 * missing one (404, no existence oracle).
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  return withApiKey(request, { scope: "packages:read", rateClass: "read" }, async (apiContext) => {
    const row = getOrgPackage(apiContext.principal.organizationId, id);
    if (!row) throw new AppError("NOT_FOUND");
    return NextResponse.json({
      package: {
        id: row.id,
        sha256: row.sha256,
        size: row.size,
        version: row.version,
        originalName: row.original_name,
        createdAt: row.created_at,
      },
    });
  });
}
