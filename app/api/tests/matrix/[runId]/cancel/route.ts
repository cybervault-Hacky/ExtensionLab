import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { cancelMatrixRun } from "@/lib/testing/matrix-service";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tests/matrix/[runId]/cancel — cancels pending/running children,
 * preserves already-completed browser results, cleans up sandboxes via the
 * job cancellation path and finalizes the matrix consistently.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { runId } = await context.params;
    if (!isSafeId(runId)) throw new AppError("NOT_FOUND", { message: "Matrix run was not found." });
    const view = cancelMatrixRun(user.id, runId);
    if (!view) throw new AppError("NOT_FOUND", { message: "Matrix run was not found." });
    return NextResponse.json(view);
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
