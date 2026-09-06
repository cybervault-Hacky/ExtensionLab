import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getOrgPackage } from "@/lib/db/repositories/packages";
import { createInteractiveSession, startInteractiveSession, toSessionView } from "@/lib/interactive/service";
import { findUserById, toUserRecord } from "@/lib/db/repositories/users";
import { recordAuditEvent } from "@/lib/audit/service";
import { enqueueJob } from "@/lib/jobs/queue";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/browser-sessions — create + queue an interactive session for a
 * stored organization package (Phase 12 public API).
 *
 * Only SAFE high-level operations are exposed: create/get/stop. Arbitrary
 * input control, navigation and inspection are deliberately NOT part of the
 * public API — the typed interactive surface stays session-cookie bound.
 * Entitlements (plan gate, quota, concurrency) are enforced by the same
 * server-side service the dashboard uses.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "browser-sessions:write", rateClass: "test" }, async (context) => {
    const body = (await request.json().catch(() => null)) as { packageId?: unknown } | null;
    if (!body || typeof body.packageId !== "string") {
      throw new AppError("INVALID_INPUT", { message: "packageId is required." });
    }
    const packageRow = getOrgPackage(context.principal.organizationId, body.packageId);
    if (!packageRow) throw new AppError("NOT_FOUND", { message: "Package not found." });
    const userRow = findUserById(context.principal.apiKey.created_by);
    if (!userRow) throw new AppError("NOT_FOUND", { message: "API key creator no longer exists." });
    const user = toUserRecord(userRow);

    // The session service resolves ownership against the key creator; only a
    // package that is BOTH org-visible and creator-owned can start a session.
    const created = createInteractiveSession(user, {
      userId: user.id,
      packageId: packageRow.id,
    });
    const queued = startInteractiveSession(user.id, created.id, (row) => {
      const { job } = enqueueJob({
        type: "INTERACTIVE_BROWSER_START",
        userId: row.user_id,
        organizationId: row.organization_id ?? undefined,
        priorityClass: "interactive",
        payload: { sessionId: row.id },
        idempotencyKey: `ibrowser-start:${row.id}`,
        resourceType: "interactive_session",
        resourceId: row.id,
      });
      return { jobId: job.id };
    });
    recordAuditEvent({
      organizationId: context.principal.organizationId,
      actorUserId: user.id,
      actorApiKeyId: context.principal.apiKey.id,
      action: "interactive_browser_started",
      resourceType: "browser_session",
      resourceId: queued.id,
      requestId: context.requestId,
      ip: context.ip,
      metadata: { via: "api" },
    });
    return NextResponse.json({ session: toSessionView(queued) }, { status: 202 });
  });
}
