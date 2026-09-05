import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getOrgReport } from "@/lib/db/repositories/reports";
import { createReportView } from "@/lib/reports/views";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/reports/:id — the private report view for the API key's
 * organization. Sanitized by the same projection the dashboard uses.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  return withApiKey(request, { scope: "reports:read", rateClass: "report" }, async (apiContext) => {
    const report = getOrgReport(apiContext.principal.organizationId, id);
    if (!report) throw new AppError("NOT_FOUND");
    let details: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(report.report_json) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") details = parsed;
    } catch {
      details = null;
    }
    const view = createReportView(report, details);
    return NextResponse.json({
      report: {
        id: report.id,
        title: report.title,
        summary: report.summary,
        healthScore: report.health_score,
        runtimeScore: report.runtime_score,
        overallScore: report.overall_score,
        createdAt: report.created_at,
        view,
      },
    });
  });
}
