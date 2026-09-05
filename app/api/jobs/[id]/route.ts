import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { cancelJob, getOwnedJobView } from "@/lib/jobs/queue";
import { getOwnedJob } from "@/lib/db/repositories/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only job status (safe projection; no payload, worker id or host details). */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new AppError("NOT_FOUND", { message: "Job not found." });
    const job = getOwnedJobView(user.id, id);
    if (!job) throw new AppError("NOT_FOUND", { message: "Job not found." });
    return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** Idempotent cancellation of an owned job. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new AppError("NOT_FOUND", { message: "Job not found." });
    const job = getOwnedJob(user.id, id);
    if (!job) throw new AppError("NOT_FOUND", { message: "Job not found." });
    cancelJob(job.id);
    return NextResponse.json({ job: getOwnedJobView(user.id, id) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
