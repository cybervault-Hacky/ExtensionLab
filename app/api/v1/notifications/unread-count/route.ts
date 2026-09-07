import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { getUnreadCount } from "@/lib/db/repositories/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "tests:read", rateClass: "read", action: "org:resources:read" }, async (apiContext) => {
    try {
      const count = getUnreadCount(apiContext.principal.apiKey.created_by);
      return NextResponse.json({ unreadCount: count });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
