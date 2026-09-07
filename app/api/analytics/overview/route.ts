import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { getOverviewAnalytics } from "@/lib/analytics/service";
import { generateOverviewInsights } from "@/lib/analytics/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "tests:read", rateClass: "read", action: "org:resources:read" }, async (apiContext) => {
    try {
      const analytics = getOverviewAnalytics();
      const insights = generateOverviewInsights(analytics);
      return NextResponse.json({ analytics, insights });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
