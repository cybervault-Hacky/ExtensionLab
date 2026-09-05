import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/browser-matrices — recent matrices for the organization (paginated). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "browser-matrix:read", rateClass: "read" }, async (context) => {
    const url = new URL(request.url);
    const page = Math.max(1, Math.min(Number(url.searchParams.get("page") ?? "1") || 1, 100));
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? "20") || 20, 50));
    const rows = getDb()
      .prepare("SELECT id, status, compatibility_score, coverage, test_suite_id, created_at, finished_at FROM browser_matrix_runs WHERE organization_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(context.principal.organizationId, limit, (page - 1) * limit) as unknown as Array<Record<string, unknown>>;
    return NextResponse.json({ matrices: rows, page, limit });
  });
}
