import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { listInteractiveSessionsAdmin, requireAdmin } from "@/lib/admin/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/browser-sessions — operator view of interactive browser
 * sessions (Phase 11): admitted (active/queued) and recently finished with
 * their stop reasons. Internal, config-gated, constant-time token authz.
 * Read-only: no shell, no Docker controls, no runtime internals.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    return NextResponse.json(
      { sessions: listInteractiveSessionsAdmin() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
