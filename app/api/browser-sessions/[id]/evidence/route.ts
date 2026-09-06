import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { listSessionEvidenceViews, saveSessionEvidence } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Evidence system (Phase 12). POST marks a runtime record (console/network/
 * event/screenshot) as evidence — the record is referenced, never copied.
 * GET lists the session's evidence with reproducibility metadata.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");
    return NextResponse.json({ evidence: listSessionEvidenceViews(user.id, id) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");
    const body = (await request.json().catch(() => null)) as {
      kind?: unknown;
      refId?: unknown;
      label?: unknown;
      detail?: unknown;
      metadata?: unknown;
    } | null;
    if (!body || typeof body.kind !== "string" || typeof body.detail !== "string") {
      throw badRequest("An evidence kind and detail are required.");
    }
    if (typeof body.detail === "string" && body.detail.length > 4000) {
      throw badRequest("The evidence detail is too long.");
    }
    const evidence = saveSessionEvidence(user.id, id, {
      kind: body.kind as "console" | "network" | "event" | "screenshot" | "test_recipe",
      refId: typeof body.refId === "string" ? body.refId : null,
      label: typeof body.label === "string" ? body.label : null,
      detail: body.detail,
      metadata:
        body.metadata && typeof body.metadata === "object"
          ? (body.metadata as Record<string, string | number | boolean | null>)
          : {},
    });
    return NextResponse.json({ evidence }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
