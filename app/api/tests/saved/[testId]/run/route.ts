import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireSameOrigin } from "@/lib/auth/api";
import { runStudioTest, runStudioTestMatrix } from "@/lib/testing/studio-service";
import { isBrowserId, type BrowserId } from "@/lib/browsers/types";
import { studioViewerFor } from "../../studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tests/saved/:testId/run — queue a run of the saved test.
 *
 * Body (all optional): { version, browser | browsers, variables, testUrl }.
 * The server validates everything; execution goes through the same Phase 13
 * queue/worker path as every other run (entitlement → concurrency → quota
 * reservation → job → fresh browser). Results are never fabricated — if no
 * worker can execute the job the run records an infrastructure error.
 */

export async function POST(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { testId } = await context.params;
    const viewer = await studioViewerFor(request, true);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null;

    const variables =
      body?.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
        ? (body.variables as Record<string, unknown>)
        : undefined;

    const browsersRaw = Array.isArray(body?.browsers) ? body.browsers : body?.browser !== undefined ? [body.browser] : [];
    const browsers = browsersRaw.filter((browser): browser is BrowserId => isBrowserId(browser));

    if (browsers.length > 1) {
      const matrix = await runStudioTestMatrix(viewer, testId, {
        source: "interactive",
        browsers,
        ...(typeof body?.version === "number" ? { version: body.version } : {}),
        ...(typeof body?.testUrl === "string" && body.testUrl.trim() !== "" ? { testUrl: body.testUrl.trim() } : {}),
        ...(variables ? { variables } : {}),
      });
      return NextResponse.json(
        {
          matrix: { browsers: matrix.browsers },
          runs: matrix.runs.map((run) => ({ runId: run.runId, jobId: run.jobId, token: run.token, status: "queued" })),
        },
        { status: 202 },
      );
    }

    if (browsersRaw.length > 0 && browsers.length === 0) throw badRequest("Unsupported browser.");

    const created = await runStudioTest(viewer, testId, {
      source: "interactive",
      ...(browsers.length === 1 ? { browserId: browsers[0] } : {}),
      ...(typeof body?.version === "number" ? { version: body.version } : {}),
      ...(typeof body?.testUrl === "string" && body.testUrl.trim() !== "" ? { testUrl: body.testUrl.trim() } : {}),
      ...(variables ? { variables } : {}),
    });
    return NextResponse.json({ runId: created.runId, jobId: created.jobId, token: created.token, status: "queued" }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
