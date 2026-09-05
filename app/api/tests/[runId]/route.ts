import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { getOwnedTestRun } from "@/lib/db/repositories/test-runs";
import { isSafeId } from "@/lib/auth/validation";
import { exportTestResults } from "@/lib/testing/diagnostics";
import { listOwnedRunArtifacts } from "@/lib/artifacts/service";
import { buildRunInfo } from "@/lib/testing/run-service";
import type { DiagnosticFinding, TestResult, TestScore } from "@/lib/testing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { runId } = await context.params;
    if (!isSafeId(runId)) throw new ApiError(404, "not_found", "Test run not found.");
    const run = getOwnedTestRun(user.id, runId);
    if (!run) throw new ApiError(404, "not_found", "Test run not found.");

    const result = run.result_json
      ? (JSON.parse(run.result_json) as {
          results?: TestResult[];
          score?: TestScore;
          diagnostics?: DiagnosticFinding[];
        })
      : null;
    const diagnostics = run.diagnostics_json
      ? (JSON.parse(run.diagnostics_json) as DiagnosticFinding[])
      : result?.diagnostics ?? [];

    const info = buildRunInfo(run);
    return NextResponse.json({
      run: {
        runId: run.id,
        status: run.status,
        stage: info.stage ?? null,
        outcome: info.outcome ?? null,
        errorCode: info.errorCode ?? null,
        reason: run.reason ?? null,
        jobId: info.jobId ?? null,
        queuePosition: info.queuePosition ?? null,
        packageId: run.package_id ?? null,
        score: run.score,
        total: run.total,
        passed: run.passed,
        failed: run.failed,
        warnings: run.warnings,
        skipped: run.skipped,
        timeout: run.timeout,
        error: run.error_count,
        startedAt: run.started_at,
        completedAt: run.completed_at,
        createdAt: run.created_at,
        extensionId: run.extension_id,
        extensionName: run.extensionName,
        extensionVersion: run.extensionVersion,
      },
      results: result?.results ?? [],
      score:
        result?.score ??
        ({
          total: run.score,
          passed: run.passed,
          failed: run.failed,
          warning: run.warnings,
          skipped: run.skipped,
          timeout: run.timeout,
          error: run.error_count,
          categories: [],
          basis: "",
        } satisfies TestScore),
      diagnostics,
      artifacts: listOwnedRunArtifacts(user.id, run.id),
      export: exportTestResults({
        runId: run.id,
        extensionName: run.extensionName ?? undefined,
        extensionVersion: run.extensionVersion ?? undefined,
        results: result?.results ?? [],
        diagnostics,
        score:
          result?.score ??
          ({
            total: run.score,
            passed: run.passed,
            failed: run.failed,
            warning: run.warnings,
            skipped: run.skipped,
            timeout: run.timeout,
            error: run.error_count,
            categories: [],
            basis: "",
          } satisfies TestScore),
        timestamps: {
          createdAt: run.created_at,
          startedAt: run.started_at ?? undefined,
          finishedAt: run.completed_at ?? undefined,
        },
      }),
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
