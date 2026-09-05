import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { AUDIT_ACTIONS, queryAuditEventsForOrg } from "@/lib/audit/service";
import { canUseOrgFeature } from "@/lib/organizations/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET — searchable, filterable audit trail (admin+). Supports action, actor,
 * resource, success, date range, free-text search (bounded) and pagination.
 */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    authorizeOrgAction(id, user.id, "org:audit:read");
    const params = new URL(request.url).searchParams;
    const number = (key: string): number | undefined => {
      const raw = params.get(key);
      if (raw === null || raw.trim() === "" || !Number.isFinite(Number(raw))) return undefined;
      return Number(raw);
    };
    const page = Math.max(1, number("page") ?? 1);
    const limit = Math.max(1, Math.min(number("limit") ?? 25, 100));
    const result = queryAuditEventsForOrg({
      organizationId: id,
      ...(params.get("action") ? { action: params.get("action")! } : {}),
      ...(params.get("actorUserId") ? { actorUserId: params.get("actorUserId")! } : {}),
      ...(params.get("resourceId") ? { resourceId: params.get("resourceId")! } : {}),
      ...(params.get("success") === "true" || params.get("success") === "false" ? { success: params.get("success") === "true" } : {}),
      ...(number("from") !== undefined ? { from: number("from") } : {}),
      ...(number("to") !== undefined ? { to: number("to") } : {}),
      ...(params.get("search") ? { search: params.get("search")!.slice(0, 120) } : {}),
      limit,
      offset: (page - 1) * limit,
    });
    return NextResponse.json({ ...result, page, limit, actions: AUDIT_ACTIONS, advanced: canUseOrgFeature(id, "advancedAuditLogs").allowed });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
