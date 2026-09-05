import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { deleteWebhook, listWebhookDeliveriesForOrg, updateWebhook } from "@/lib/webhooks/service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; webhookId: string }> };

/** GET — delivery history for one webhook. */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id, webhookId } = await context.params;
    authorizeOrgAction(id, user.id, "org:webhooks:manage");
    const page = Math.max(1, Number(new URL(request.url).searchParams.get("page") ?? "1") || 1);
    return NextResponse.json(listWebhookDeliveriesForOrg(id, webhookId, page, 20));
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** PATCH — update URL/events/active (re-runs SSRF validation). */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, webhookId } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:webhooks:manage");
    const body = (await request.json().catch(() => ({}))) as { url?: unknown; events?: unknown; active?: unknown };
    const webhook = await updateWebhook(
      { userId: user.id, organizationId: id, ip: getClientIp(request) },
      webhookId,
      {
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(body.events !== undefined ? { events: body.events } : {}),
        ...(body.active !== undefined ? { active: Boolean(body.active) } : {}),
      },
    );
    return NextResponse.json({ webhook });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** DELETE — remove a webhook. */
export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, webhookId } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:webhooks:manage");
    deleteWebhook({ userId: user.id, organizationId: id, ip: getClientIp(request) }, webhookId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
