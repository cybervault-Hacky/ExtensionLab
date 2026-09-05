import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxToken } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { buildRunInfo, resolveAccessibleRun } from "@/lib/testing/run-service";
import { ensureEmbeddedWorker, notifyEmbeddedWorker } from "@/lib/jobs/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 6: runs are queued at creation, so "start" is idempotent — it simply
 * confirms the run is scheduled and returns its current state.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { runId } = await context.params;
    if (!isSafeId(runId)) throw new AppError("NOT_FOUND", { message: "Test run was not found." });
    const run = resolveAccessibleRun(user.id, runId, getSandboxToken(request));
    ensureEmbeddedWorker();
    notifyEmbeddedWorker();
    return NextResponse.json(buildRunInfo(run));
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
