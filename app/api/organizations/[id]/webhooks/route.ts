import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { createWebhook, listOrganizationWebhooks } from "@/lib/webhooks/service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** GET — webhooks + recent delivery history. */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    authorizeOrgAction(id, user.id, "org:webhooks:manage");
    return NextResponse.json({ webhooks: listOrganizationWebhooks(id) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST — register a webhook (HTTPS + SSRF-validated). Secret shown once. */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:webhooks:manage");
    const body = (await request.json().catch(() => null)) as { url?: unknown; events?: unknown } | null;
    if (!body || typeof body.url !== "string") throw badRequest("A HTTPS webhook URL is required.");
    const created = await createWebhook({ userId: user.id, organizationId: id, ip: getClientIp(request) }, { url: body.url, events: body.events });
    return NextResponse.json({ webhook: created, secret: created.secret, shownOnce: true }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
