import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { getAccessibleSavedTest } from "@/lib/db/repositories/saved-tests";
import { getOrgTestRun } from "@/lib/db/repositories/test-runs";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { AppError } from "@/lib/observability/errors";
import { ciRunExitCode, ciRunStatus } from "@/lib/api/v1-tests-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/tests/:testId/runs/:runId — poll a single run (§53).
 *
 * Organization-scoped: the saved test must belong to the API key's
 * organization and the run must have been created for that organization.
 * Returns the CI status enum plus per-test results once finished. Results are
 * only ever the real execution outcomes recorded by the worker — this route
 * has no way to fabricate a result.
 */

export async function GET(request: NextRequest, context: { params: Promise<{ testId: string; runId: string }> }): Promise<NextResponse> {
  const { testId, runId } = await context.params;
  return withApiKey(request, { scope: "tests:read", rateClass: "read", action: "org:resources:read" }, async (apiContext) => {
    try {
      const organizationId = apiContext.principal.organizationId;
      const test = getAccessibleSavedTest(
        { userId: apiContext.principal.apiKey.created_by, organizationId },
        testId,
      );
      if (!test) throw new AppError("NOT_FOUND", { message: "Test not found." });

      const run = organizationId ? getOrgTestRun(organizationId, runId) : getTestRunById(runId);
      if (!run || run.saved_test_id !== testId) throw new AppError("NOT_FOUND", { message: "Run not found for this test." });

      const mapped = ciRunStatus(run);
      const finished = !["QUEUED", "STARTING", "RUNNING"].includes(mapped.status);
      let results: Array<Record<string, unknown>> | undefined;
      if (finished && run.result_json) {
        try {
          const parsed = JSON.parse(run.result_json) as { results?: Array<{ testId?: string; name?: string; status?: string; duration?: number; assertions?: Array<{ passed?: boolean; skipped?: boolean; message?: string }> }> };
          results = (parsed.results ?? []).map((result) => ({
            testId: result.testId,
            name: result.name,
            status: (result.status ?? "unknown").toUpperCase(),
            durationMs: result.duration ?? null,
            assertions: {
              total: result.assertions?.length ?? 0,
              passed: result.assertions?.filter((entry) => entry.passed === true).length ?? 0,
              failed: result.assertions?.filter((entry) => entry.passed === false && entry.skipped !== true).length ?? 0,
              skipped: result.assertions?.filter((entry) => entry.skipped === true).length ?? 0,
            },
          }));
        } catch {
          results = undefined;
        }
      }

      return NextResponse.json({
        run: {
          id: run.id,
          testId,
          testVersion: run.saved_test_version,
          status: mapped.status,
          detail: mapped.detail,
          browser: run.browser_id ?? "chromium",
          createdAt: new Date(run.created_at).toISOString(),
          startedAt: run.started_at ? new Date(run.started_at).toISOString() : null,
          finishedAt: run.completed_at ? new Date(run.completed_at).toISOString() : null,
          totals: { total: run.total, passed: run.passed, failed: run.failed, warnings: run.warnings, skipped: run.skipped },
          /** CI exit semantics: only COMPLETED exits 0 (§86). */
          exitCode: ciRunExitCode(mapped.status),
          ...(results !== undefined ? { results } : {}),
        },
      });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
