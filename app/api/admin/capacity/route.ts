import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { requireAdmin } from "@/lib/admin/service";
import { getCapacitySnapshot } from "@/lib/admin/capacity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/capacity — capacity + queue + autoscaling signals (§46/§82).
 * Internal, token-gated. Slot counts are aggregate numbers only; exact
 * infrastructure capacity is never exposed publicly.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    return NextResponse.json(getCapacitySnapshot(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
