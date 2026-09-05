import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxToken } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { cancelRun, resolveAccessibleRun } from "@/lib/testing/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Idempotent cancellation: queued runs stop immediately, running ones are stopped by the worker. */
export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { runId } = await context.params;
    if (!isSafeId(runId)) throw new AppError("NOT_FOUND", { message: "Test run was not found." });
    const run = resolveAccessibleRun(user.id, runId, getSandboxToken(request));
    return NextResponse.json(cancelRun(run));
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
