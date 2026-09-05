import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  requireApiUser,
  requireSameOrigin,
} from "@/lib/auth/api";
import { getOwnedExtension } from "@/lib/db/repositories/extensions";
import { getLatestSnapshot, getOwnedSnapshot } from "@/lib/db/repositories/snapshots";
import { getOwnedTestRun } from "@/lib/db/repositories/test-runs";
import { createReport, listReports } from "@/lib/db/repositories/reports";
import type { ReportSort } from "@/lib/db/repositories/reports";
import { parsePagination, parseSort, isSafeId } from "@/lib/auth/validation";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { rateLimited } from "@/lib/auth/api";
import { getClientIp } from "@/lib/runtime/api-helpers";

import type { ExtensionAnalysis } from "@/types/extension";
import type { TestRunRow } from "@/lib/db/schema/types";

function runOutcomeOf(run: TestRunRow): string {
  if (run.outcome) return run.outcome;
  // Phase 5 rows predate the outcome column: derive from the legacy status.
  if (run.status === "completed") return run.failed + run.error_count > 0 ? "FAILED" : run.warnings > 0 ? "WARNING" : "PASSED";
  if (run.status === "timeout") return "TIMEOUT";
  if (run.status === "destroyed") return "CANCELLED";
  return "INFRASTRUCTURE_ERROR";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const url = new URL(request.url);
    const page = parsePagination(url, { page: 1, limit: 12 });
    const sort = parseSort<ReportSort>(
      url.searchParams.get("sort"),
      ["newest", "oldest", "score_desc", "score_asc", "name"] as const,
      "newest",
    );
    const data = listReports(user.id, {
      page: page.page,
      limit: page.limit,
      search: url.searchParams.get("q") ?? undefined,
      sort,
    });
    return NextResponse.json({ items: data.items, page: page.page, limit: page.limit, total: data.total });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const limit = enforceRateLimit("reportCreate", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw badRequest("Invalid request body.");

    const extensionId = typeof body.extensionId === "string" ? body.extensionId : "";
    const snapshotId = typeof body.analysisSnapshotId === "string" ? body.analysisSnapshotId : "";
    const testRunId = typeof body.testRunId === "string" ? body.testRunId : "";
    if (!extensionId || !isSafeId(extensionId)) throw badRequest("A valid extension is required.");

    const extension = getOwnedExtension(user.id, extensionId);
    if (!extension) throw new ApiError(404, "not_found", "Extension not found.");

    let snapshot = snapshotId ? getOwnedSnapshot(user.id, snapshotId) : null;
    if (!snapshot && !snapshotId) {
      snapshot = getLatestSnapshot(extension.id);
    }
    if (!snapshot) {
      throw new ApiError(404, "not_found", "Analysis snapshot not found.");
    }

    let testRun = testRunId ? getOwnedTestRun(user.id, testRunId) : null;
    if (testRunId && !testRun) throw new ApiError(404, "not_found", "Test run not found.");

    if (testRun && !["completed", "failed", "timeout", "destroyed"].includes(testRun.status)) {
      throw new ApiError(409, "conflict", "Wait for the test run to finish before generating a report.");
    }

    const analysis = JSON.parse(snapshot.analysis_json) as ExtensionAnalysis;
    const testResult = testRun?.result_json ? (JSON.parse(testRun.result_json) as Record<string, unknown>) : null;
    const healthScore = extension.health_score;
    // Runtime status is reported honestly: a run whose sandbox never executed
    // any test (infrastructure error / cancellation) has no runtime score and
    // must not drag the overall score to 0 or be presented as "0/100".
    const runOutcome = testRun ? runOutcomeOf(testRun) : null;
    const runtimeExecuted = testRun ? runOutcome !== "INFRASTRUCTURE_ERROR" && runOutcome !== "CANCELLED" : false;
    const runtimeScore = testRun && runtimeExecuted ? testRun.score : null;
    const overallScore = runtimeScore !== null ? Math.round((healthScore + runtimeScore) / 2) : healthScore;

    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 140)
        : `${extension.name} Report`;
    const runtimeSummary = !testRun
      ? ""
      : runtimeScore !== null
        ? ` · runtime ${runtimeScore}/100`
        : runOutcome === "CANCELLED"
          ? " · runtime tests cancelled"
          : " · runtime tests not executed (infrastructure error)";
    const summary = `${extension.name} · health ${healthScore}/100${runtimeSummary}`;

    const reportJson = {
      schemaVersion: 1,
      title,
      extension: {
        id: extension.id,
        name: extension.name,
        version: extension.version,
        manifestVersion: extension.manifest_version,
      },
      staticAnalysis: {
        healthScore,
        analysis: {
          id: snapshot.id,
          manifestVersion: extension.manifest_version,
          snapshotAt: snapshot.created_at,
        },
        issues: analysis.issues,
        permissions: analysis.permissions,
        healthScoreCategories: analysis.healthScore.categories,
      },
      runtimeTests: testRun
        ? {
            runId: testRun.id,
            score: runtimeScore,
            status: testRun.status,
            outcome: runOutcome,
            errorCode: testRun.error_code ?? null,
            reason: testRun.reason ?? null,
            runtimeStatus: runtimeExecuted ? "executed" : "not-executed",
            summary: {
              total: testRun.total,
              passed: testRun.passed,
              failed: testRun.failed,
              warnings: testRun.warnings,
              skipped: testRun.skipped,
              timeout: testRun.timeout,
              error: testRun.error_count,
            },
            details: testResult,
          }
        : null,
      overallScore,
      createdAt: Date.now(),
      generatedWith: "ExtensionLab",
    };

    const report = createReport({
      userId: user.id,
      extensionId: extension.id,
      analysisSnapshotId: snapshot.id,
      testRunId: testRun?.id ?? null,
      title,
      summary,
      healthScore,
      runtimeScore,
      overallScore,
      reportJson: JSON.stringify(reportJson),
    });

    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
