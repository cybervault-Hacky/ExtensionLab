import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { canUseRegressionTesting } from "@/lib/billing/entitlements";
import { deleteBaseline, getBaselineForExtension } from "@/lib/db/repositories/baselines";
import { getOwnedMatrixRun } from "@/lib/db/repositories/browser-matrix";
import { getOwnedTestRun } from "@/lib/db/repositories/test-runs";
import { getOwnedExtension } from "@/lib/db/repositories/extensions";
import { getLatestSnapshot } from "@/lib/db/repositories/snapshots";
import { setBaseline } from "@/lib/db/repositories/baselines";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Baselines pin the exact package version, analysis snapshot, test suite and
 * browser configuration a future run is compared against. A baseline never
 * resolves to an ambiguous "latest".
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const extensionId = new URL(request.url).searchParams.get("extensionId");
    if (!extensionId || !isSafeId(extensionId)) throw badRequest("A valid extension id is required.");
    const baseline = getBaselineForExtension(user.id, extensionId);
    return NextResponse.json({ baseline });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const entitlement = canUseRegressionTesting(user.id);
    if (!entitlement.allowed) {
      throw new AppError("PAYMENT_REQUIRED", {
        message: entitlement.reason === "plan" ? entitlement.message : undefined,
      });
    }
    const body = (await request.json().catch(() => null)) as { matrixRunId?: unknown; runId?: unknown } | null;
    if (!body) throw badRequest("Invalid request body.");
    const matrixRunId = typeof body.matrixRunId === "string" && body.matrixRunId.trim() !== "" ? body.matrixRunId : null;
    const runId = typeof body.runId === "string" && body.runId.trim() !== "" ? body.runId : null;
    if (!matrixRunId && !runId) throw badRequest("A matrix run id or run id is required.");

    if (matrixRunId) {
      if (!isSafeId(matrixRunId)) throw badRequest("A valid matrix run id is required.");
      const matrix = getOwnedMatrixRun(user.id, matrixRunId);
      if (!matrix) throw new AppError("NOT_FOUND", { message: "Matrix run was not found." });
      if (!["completed", "partial"].includes(matrix.status)) {
        throw new AppError("CONFLICT", { message: "Only finished matrix runs can become a baseline." });
      }
      const baseline = setBaseline({
        userId: user.id,
        extensionId: matrix.extension_id ?? "",
        packageId: matrix.package_id,
        snapshotId: matrix.extension_id ? (getLatestSnapshot(matrix.extension_id)?.id ?? null) : null,
        testSuiteId: matrix.test_suite_id,
        browsers: JSON.parse(matrix.browsers_json) as string[],
        matrixRunId: matrix.id,
        score: matrix.compatibility_score,
      });
      return NextResponse.json({ baseline }, { status: 201 });
    }

    if (!isSafeId(runId!)) throw badRequest("A valid run id is required.");
    const run = getOwnedTestRun(user.id, runId!);
    if (!run) throw new AppError("NOT_FOUND", { message: "Test run was not found." });
    if (!["completed", "timeout"].includes(run.status)) {
      throw new AppError("CONFLICT", { message: "Only finished runs can become a baseline." });
    }
    const baseline = setBaseline({
      userId: user.id,
      extensionId: run.extension_id ?? "",
      packageId: run.package_id ?? "",
      snapshotId: run.extension_id ? (getLatestSnapshot(run.extension_id)?.id ?? null) : null,
      testSuiteId: "core",
      browsers: [run.browser_id ?? "chromium"],
      runId: run.id,
      score: run.score,
    });
    return NextResponse.json({ baseline }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const extensionId = new URL(request.url).searchParams.get("extensionId");
    if (!extensionId || !isSafeId(extensionId)) throw badRequest("A valid extension id is required.");
    if (!getOwnedExtension(user.id, extensionId)) {
      throw new AppError("NOT_FOUND", { message: "Extension not found." });
    }
    const deleted = deleteBaseline(user.id, extensionId);
    return NextResponse.json({ deleted });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
