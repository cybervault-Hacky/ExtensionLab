import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getSessionById, getOwnedSession } from "@/lib/db/repositories/browser-sessions";
import { stopInteractiveSession, toSessionView } from "@/lib/interactive/service";
import { createDockerDriver } from "@/lib/runtime/docker-driver";
import { recordAuditEvent } from "@/lib/audit/service";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/browser-sessions/{id}/stop — stop a session owned by the key's
 * organization. Teardown is the same deterministic path the dashboard uses.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withApiKey(request, { scope: "browser-sessions:write", rateClass: "test" }, async (apiKeyContext) => {
    const { id } = await context.params;
    const row = getSessionById(id);
    if (!row || row.organization_id !== apiKeyContext.principal.organizationId) {
      throw new AppError("NOT_FOUND", { message: "Browser session not found." });
    }
    // Ownership re-checked by the service against the key creator.
    const creatorOwned = getOwnedSession(apiKeyContext.principal.apiKey.created_by, id);
    if (!creatorOwned) {
      throw new AppError("FORBIDDEN", { message: "Only the session creator can stop it via the API." });
    }
    const stopped = await stopInteractiveSession(creatorOwned.user_id, id, createDockerDriver());
    recordAuditEvent({
      organizationId: apiKeyContext.principal.organizationId,
      actorUserId: creatorOwned.user_id,
      actorApiKeyId: apiKeyContext.principal.apiKey.id,
      action: "interactive_browser_stopped",
      resourceType: "browser_session",
      resourceId: id,
      requestId: apiKeyContext.requestId,
      ip: apiKeyContext.ip,
      metadata: { via: "api" },
    });
    return NextResponse.json({ session: toSessionView(stopped) });
  });
}
