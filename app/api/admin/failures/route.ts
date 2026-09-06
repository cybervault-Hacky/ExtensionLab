import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { requireAdmin } from "@/lib/admin/service";
import { getFailureSnapshot } from "@/lib/admin/capacity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/failures — failure classification view (§25/§56). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    return NextResponse.json(getFailureSnapshot(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
