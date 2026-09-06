import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { createSessionTestRecipe } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create Test From Actions (Phase 12): converts explicitly confirmed session
 * actions into a validated test recipe. Every step passes the existing Phase 4
 * selector/URL/bounds validation; nothing arbitrary is executable.
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
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      actions?: unknown;
      confirm?: unknown;
    } | null;
    if (!body || typeof body.name !== "string" || !Array.isArray(body.actions)) {
      throw badRequest("A test name and actions array are required.");
    }
    if (body.confirm !== true) {
      throw badRequest("Explicit confirmation is required before saving a test.");
    }
    const recipe = await createSessionTestRecipe(user.id, id, {
      name: body.name,
      actions: body.actions as never,
      confirm: true,
    });
    return NextResponse.json({ recipe }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
