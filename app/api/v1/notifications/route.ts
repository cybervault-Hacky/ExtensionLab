import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { listNotifications, getUnreadCount } from "@/lib/db/repositories/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "tests:read", rateClass: "read", action: "org:resources:read" }, async (apiContext) => {
    try {
      const url = new URL(request.url);
      const unreadOnly = url.searchParams.get("unread") === "1";
      const page = Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);
      const listed = listNotifications(apiContext.principal.apiKey.created_by, { unreadOnly, page, limit });
      return NextResponse.json({
        notifications: listed.items.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          readAt: n.read_at,
          createdAt: n.created_at,
          entityType: n.entity_type,
          entityId: n.entity_id,
        })),
        pagination: { page, limit, total: listed.total },
        unreadCount: getUnreadCount(apiContext.principal.apiKey.created_by),
      });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
