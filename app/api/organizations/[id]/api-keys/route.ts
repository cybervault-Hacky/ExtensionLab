import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { createApiKey, listOrganizationApiKeys } from "@/lib/api-keys/service";
import { canUseOrgFeature } from "@/lib/organizations/entitlements";
import { AppError } from "@/lib/observability/errors";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET — API keys (admin+; secrets never returned, only prefixes). */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:api-keys:manage");
    return NextResponse.json({ keys: listOrganizationApiKeys(ctx) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST — create an API key. The raw secret is returned exactly once. */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:api-keys:manage");
    if (!canUseOrgFeature(id, "apiAccess").allowed) throw new AppError("PAYMENT_REQUIRED", { message: "API access requires a Pro plan or higher." });
    const body = (await request.json().catch(() => null)) as { name?: unknown; scopes?: unknown; expiresInDays?: unknown } | null;
    if (!body || typeof body.name !== "string") throw badRequest("A key name is required.");
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === "string") : undefined;
    const expiresInDays = typeof body.expiresInDays === "number" && Number.isFinite(body.expiresInDays) ? Math.max(1, Math.min(Math.floor(body.expiresInDays), 730)) : null;
    const created = createApiKey(
      { userId: user.id, organizationId: id, ip: getClientIp(request) },
      { name: body.name, ...(scopes ? { scopes } : {}), expiresAt: expiresInDays ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000 : null },
    );
    return NextResponse.json({ key: created.key, shownOnce: true }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
