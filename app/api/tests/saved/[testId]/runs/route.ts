import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireSameOrigin } from "@/lib/auth/api";
import { listTestRuns } from "@/lib/db/repositories/test-runs";
import { requireAccessibleTest } from "@/lib/testing/studio-service";
import { studioViewerFor } from "../../studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tests/saved/:testId/runs — bounded, paginated run history for one
 * saved test. Runs are immutable rows written by the worker; this endpoint
 * only reads them.
 */

export async function GET(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { testId } = await context.params;
    const viewer = await studioViewerFor(request, false);
    requireAccessibleTest(viewer, testId);
    const url = new URL(request.url);
    const page = Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);
    const listed = listTestRuns(viewer.userId, { page, limit, savedTestId: testId });
    return NextResponse.json({
      runs: listed.items.map((run) => ({
        id: run.id,
        status: run.status,
        outcome: run.outcome,
        saved_test_version: run.saved_test_version ?? null,
        browser: run.browser_id ?? "chromium",
        passed: run.passed,
        failed: run.failed,
        warnings: run.warnings,
        total: run.total,
        created_at: run.created_at,
      })),
      pagination: { page, limit, total: listed.total },
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
