import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { toSessionView } from "@/lib/interactive/service";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/browser-sessions/{id} — safe session status (no runtime internals). */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withApiKey(request, { scope: "browser-sessions:read", rateClass: "read" }, async (apiKeyContext) => {
    const { id } = await context.params;
    const row = getSessionById(id);
    if (!row || row.organization_id !== apiKeyContext.principal.organizationId) {
      throw new AppError("NOT_FOUND", { message: "Browser session not found." });
    }
    return NextResponse.json({ session: toSessionView(row) }, { headers: { "cache-control": "no-store" } });
  });
}
