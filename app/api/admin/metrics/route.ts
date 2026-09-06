import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { requireAdmin } from "@/lib/admin/service";
import { metricsSnapshot } from "@/lib/observability/metrics-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/metrics — process-local metric snapshot (§52): counters and
 * latency histograms recorded by THIS instance. Multi-replica deployments
 * scrape each instance (documented in docs/OPERATIONS.md). No secrets.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    return NextResponse.json(metricsSnapshot(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
