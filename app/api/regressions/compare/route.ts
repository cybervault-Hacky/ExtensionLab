import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { compareForRegression, getRegressionResult, resolveBaselineSide } from "@/lib/testing/regression-service";
import { listRegressionComparisons } from "@/lib/db/repositories/regressions";
import { getOwnedMatrixRun } from "@/lib/db/repositories/browser-matrix";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/regressions/compare — compare a previous run/matrix against a
 * current one (same suite, per browser). The previous side must be explicit
 * (or the extension's designated baseline); "latest" is never guessed here.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const body = (await request.json().catch(() => null)) as {
      previousMatrixRunId?: unknown;
      previousRunId?: unknown;
      currentMatrixRunId?: unknown;
      currentRunId?: unknown;
    } | null;
    if (!body) throw badRequest("Invalid request body.");
    const idOrNull = (value: unknown): string | null =>
      typeof value === "string" && value.trim() !== "" ? (isSafeId(value) ? value : null) : null;
    if (idOrNull(body.currentMatrixRunId) === null && idOrNull(body.currentRunId) === null) {
      throw badRequest("A current run or matrix run id is required.");
    }
    // The previous side is explicit, or the extension's designated baseline —
    // never an ambiguous "latest".
    let previous: { matrixRunId: string | null; runId: string | null } = {
      matrixRunId: idOrNull(body.previousMatrixRunId),
      runId: idOrNull(body.previousRunId),
    };
    if (previous.matrixRunId === null && previous.runId === null) {
      const currentMatrixId = idOrNull(body.currentMatrixRunId);
      const currentMatrix = currentMatrixId ? getOwnedMatrixRun(user.id, currentMatrixId) : null;
      const extensionId = currentMatrix?.extension_id ?? null;
      const baselineSide = extensionId ? resolveBaselineSide(user.id, extensionId) : null;
      if (!baselineSide || (!baselineSide.matrixRunId && !baselineSide.runId)) {
        throw new AppError("CONFLICT", {
          message: "No baseline is designated for this extension. Designate a finished run as the baseline first.",
        });
      }
      previous = { matrixRunId: baselineSide.matrixRunId ?? null, runId: baselineSide.runId ?? null };
    }
    const { comparisonId, result } = compareForRegression({
      userId: user.id,
      previous,
      current: {
        matrixRunId: idOrNull(body.currentMatrixRunId),
        runId: idOrNull(body.currentRunId),
      },
    });
    return NextResponse.json({ comparisonId, result }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** GET /api/regressions/compare?id=... (stored result) or ?list=1 (recent comparisons). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      if (!isSafeId(id)) throw new AppError("NOT_FOUND", { message: "Comparison not found." });
      const result = getRegressionResult(user.id, id);
      if (!result) throw new AppError("NOT_FOUND", { message: "Comparison not found." });
      return NextResponse.json({ comparisonId: id, result });
    }
    return NextResponse.json({
      items: listRegressionComparisons(user.id).map((row) => ({
        id: row.id,
        regressions: row.regression_count,
        improvements: row.improvement_count,
        browsers: JSON.parse(row.browsers_json) as string[],
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
