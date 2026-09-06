import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { reconcileNowAdmin, requireAdmin } from "@/lib/admin/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/reconcile — enqueue the idempotent interactive cleanup job
 * (stale sessions, orphaned containers, expired artifacts) now. Audited.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const result = reconcileNowAdmin(request.headers.get("x-request-id"));
    return NextResponse.json({ enqueued: result });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
