import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { getOwnedReport } from "@/lib/db/repositories/reports";
import { isSafeId } from "@/lib/auth/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new ApiError(404, "not_found", "Report not found.");
    const report = getOwnedReport(user.id, id);
    if (!report) throw new ApiError(404, "not_found", "Report not found.");
    const payload = JSON.parse(report.report_json);
    const { createReportView } = await import("@/lib/reports/views");
    return NextResponse.json(createReportView(report, payload));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
