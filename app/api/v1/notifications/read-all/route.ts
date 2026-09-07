import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { markAllNotificationsRead } from "@/lib/db/repositories/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "tests:write", rateClass: "test", action: "org:tests:run" }, async (apiContext) => {
    try {
      const count = markAllNotificationsRead(apiContext.principal.apiKey.created_by);
      return NextResponse.json({ status: "read_all", count });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
