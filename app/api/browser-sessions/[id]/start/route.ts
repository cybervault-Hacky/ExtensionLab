import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { enqueueJob } from "@/lib/jobs/queue";
import { ensureEmbeddedWorker, notifyEmbeddedWorker } from "@/lib/jobs/runtime";
import { startInteractiveSession, toSessionView } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enqueues the INTERACTIVE_BROWSER_START job for a CREATED session. The
 * request returns immediately; the workspace follows progress over SSE.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");

    ensureEmbeddedWorker();
    const row = startInteractiveSession(user.id, id, (session) => {
      const { job } = enqueueJob({
        type: "INTERACTIVE_BROWSER_START",
        userId: user.id,
        organizationId: session.organization_id,
        priorityClass: "interactive",
        payload: { sessionId: session.id },
        idempotencyKey: `ibrowser-start:${session.id}`,
        resourceType: "interactive_session",
        resourceId: session.id,
        maxAttempts: 6,
      });
      return { jobId: job.id };
    });
    notifyEmbeddedWorker();
    return NextResponse.json({ session: toSessionView(row) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
