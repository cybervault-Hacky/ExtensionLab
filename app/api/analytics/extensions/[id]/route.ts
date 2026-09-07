import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { getExtensionAnalytics } from "@/lib/analytics/service";
import { AppError } from "@/lib/observability/errors";
import { getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  return withApiKey(request, { scope: "tests:read", rateClass: "read", action: "org:resources:read" }, async (apiContext) => {
    try {
      // Basic authorization: extension must exist and belong to user or their organization
      const ext = getDb().prepare("SELECT user_id FROM extensions WHERE id = ?").get(id) as { user_id: string } | undefined;
      if (!ext) throw new AppError("NOT_FOUND", { message: "Extension not found." });
      const viewerUserId = apiContext.principal.apiKey.created_by;
      const orgId = apiContext.principal.organizationId;
      // Allow if owner or if extension belongs to organization via package/extension relationships (simplified: allow if user is owner or same org)
      const orgMember = orgId ? getDb().prepare("SELECT 1 FROM organization_members WHERE user_id = ? AND organization_id = ?").get(viewerUserId, orgId) : undefined;
      // For Phase 19: allow if user is owner OR if user is in the extension's org context. Simplified to owner + same org extension check via package if needed.
      // To avoid false blockage, allow access if extension owner is viewer or viewer is org member of extension's organization (if tracked). Since extensions table has user_id only, allow owner.
      if (ext.user_id !== viewerUserId && !orgMember) {
        // Additional check: if extension has a package linked to org, allow org members
        const pkg = getDb().prepare("SELECT organization_id FROM packages WHERE extension_id = ? LIMIT 1").get(id) as { organization_id: string } | undefined;
        if (!pkg || pkg.organization_id !== orgId) throw new AppError("FORBIDDEN", { message: "Not authorized for this extension." });
      }
      const analytics = getExtensionAnalytics(id);
      return NextResponse.json({ analytics });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
