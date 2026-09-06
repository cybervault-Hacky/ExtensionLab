import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireSameOrigin } from "@/lib/auth/api";
import { compareRunToBaseline, describeBaseline, saveRunAsBaseline } from "@/lib/testing/studio-service";
import { studioViewerFor } from "../../studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/tests/saved/:testId/baseline — the saved baseline (if any).
 * GET  …?runId=x — deterministic comparison of run x against the baseline.
 * POST /api/tests/saved/:testId/baseline { runId } — Save Run as Baseline.
 *
 * Classification is computed by a pure function (NEW_FAILURE / FIXED_FAILURE /
 * UNCHANGED_FAILURE / NEW_WARNING / PERFORMANCE_REGRESSION / NO_REGRESSION);
 * AI is never involved (§48).
 */

export async function GET(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { testId } = await context.params;
    const viewer = await studioViewerFor(request, false);
    const runId = new URL(request.url).searchParams.get("runId");
    if (runId) {
      return NextResponse.json(compareRunToBaseline(viewer, testId, runId));
    }
    const baseline = describeBaseline(viewer, testId);
    return NextResponse.json({ baseline });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { testId } = await context.params;
    const viewer = await studioViewerFor(request, true);
    const body = (await request.json().catch(() => null)) as { runId?: unknown } | null;
    if (!body || typeof body.runId !== "string") throw badRequest("runId is required.");
    const baseline = saveRunAsBaseline(viewer, testId, body.runId);
    return NextResponse.json({
      baseline: { runId: baseline.run_id, version: baseline.test_version, outcome: baseline.outcome, createdAt: baseline.created_at },
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
