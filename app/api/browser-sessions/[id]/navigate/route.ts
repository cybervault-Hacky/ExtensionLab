import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { navigateSession, toSessionView } from "@/lib/interactive/service";
import { MAX_URL_INPUT_LENGTH } from "@/lib/interactive/limits";
import type { NavigationOperation } from "@/types/interactive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Navigation operations: {op:"navigate", url}, {op:"back"}, {op:"forward"},
 * {op:"reload"}. Every URL passes the existing safe-URL policy (scheme
 * allowlist, SSRF/private-network blocking, DNS pinning) — the runner
 * validates a second time inside the container.
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

    const body = (await request.json().catch(() => null)) as { op?: unknown; url?: unknown } | null;
    let operation: NavigationOperation;
    if (body?.op === "back" || body?.op === "forward" || body?.op === "reload") {
      operation = { op: body.op };
    } else if (body?.op === "navigate" && typeof body.url === "string" && body.url.length <= MAX_URL_INPUT_LENGTH) {
      operation = { op: "navigate", url: body.url };
    } else {
      throw badRequest("Expected {op:\"navigate\", url} or {op:\"back\"|\"forward\"|\"reload\"}.");
    }

    const row = await navigateSession(user.id, id, operation);
    return NextResponse.json({ session: toSessionView(row) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
