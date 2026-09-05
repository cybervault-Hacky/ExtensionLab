import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getOrgTestRun } from "@/lib/db/repositories/test-runs";
import { parseResults } from "@/lib/testing/run-service";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/test-runs/:id — run status + per-test results (org-scoped). */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  return withApiKey(request, { scope: "tests:read", rateClass: "read" }, async (apiContext) => {
    const run = getOrgTestRun(apiContext.principal.organizationId, id);
    if (!run) throw new AppError("NOT_FOUND");
    const parsed = parseResults(run);
    return NextResponse.json({
      testRun: {
        id: run.id,
        status: run.status,
        stage: run.stage,
        outcome: run.outcome,
        errorCode: run.error_code,
        score: run.score,
        browserId: run.browser_id,
        browserVersion: run.browser_version,
        total: run.total,
        passed: run.passed,
        failed: run.failed,
        skipped: run.skipped,
        createdAt: run.created_at,
        startedAt: run.started_at,
        finishedAt: run.completed_at,
        results: parsed.results.map((result) => ({
          testId: result.testId,
          name: result.name,
          status: result.status,
          ...(result.errors.length > 0 ? { errors: result.errors.slice(0, 5) } : {}),
        })),
      },
    });
  });
}
