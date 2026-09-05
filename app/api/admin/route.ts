import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { getAdminOverview, requireAdmin } from "@/lib/admin/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin — queue depth + live worker health. Internal, config-gated
 * (ADMIN_API_ENABLED + ADMIN_API_TOKEN), constant-time token authz, audited
 * actions elsewhere. Jobs/queue only: no shell, no Docker execution.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    return NextResponse.json(getAdminOverview(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
