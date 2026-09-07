import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { markNotificationRead } from "@/lib/db/repositories/notifications";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  return withApiKey(request, { scope: "tests:write", rateClass: "test", action: "org:tests:run" }, async (apiContext) => {
    try {
      const ok = markNotificationRead(id, apiContext.principal.apiKey.created_by);
      if (!ok) throw new AppError("NOT_FOUND", { message: "Notification not found or already read." });
      return NextResponse.json({ status: "read", id });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
