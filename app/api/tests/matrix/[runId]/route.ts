import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { getMatrixRunView } from "@/lib/testing/matrix-service";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tests/matrix/[runId] — aggregated matrix state, executions and comparison. */
export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { runId } = await context.params;
    if (!isSafeId(runId)) throw new AppError("NOT_FOUND", { message: "Matrix run was not found." });
    const view = getMatrixRunView(user.id, runId);
    if (!view) throw new AppError("NOT_FOUND", { message: "Matrix run was not found." });
    return NextResponse.json(view);
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
