import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxToken } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { buildRunInfo, parseResults, resolveAccessibleRun } from "@/lib/testing/run-service";
import { listOwnedRunArtifacts } from "@/lib/artifacts/service";
import type { TestScore } from "@/lib/testing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { runId } = await context.params;
    if (!isSafeId(runId)) throw new AppError("NOT_FOUND", { message: "Test run was not found." });
    const run = resolveAccessibleRun(user.id, runId, getSandboxToken(request));
    const info = buildRunInfo(run);
    const parsed = parseResults(run);
    const score: TestScore =
      parsed.score ??
      ({
        total: run.score,
        passed: run.passed,
        failed: run.failed,
        warning: run.warnings,
        skipped: run.skipped,
        timeout: run.timeout,
        error: run.error_count,
        categories: [],
        basis:
          info.outcome === "INFRASTRUCTURE_ERROR" || info.outcome === "CANCELLED"
            ? "No automated tests were executed."
            : "No automated tests have completed yet.",
      } satisfies TestScore);
    return NextResponse.json(
      {
        results: parsed.results,
        score,
        diagnostics: parsed.diagnostics,
        outcome: info.outcome ?? null,
        errorCode: info.errorCode ?? null,
        artifacts: run.user_id === user.id ? listOwnedRunArtifacts(user.id, run.id) : [],
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
