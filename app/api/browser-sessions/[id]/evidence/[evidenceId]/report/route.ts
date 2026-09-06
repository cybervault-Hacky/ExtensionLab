import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { attachSessionEvidenceToReportById } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Save to Report (Phase 12): attaches evidence to a report the caller owns
 * (a new evidence report is created when no reportId is supplied). The report
 * gains a bounded reference with package version/SHA-256, browser/version,
 * timestamp and session id — everything needed for reproducibility.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; evidenceId: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, evidenceId } = await context.params;
    if (!isSafeId(id) || !isSafeId(evidenceId)) throw badRequest("Invalid id.");
    const body = (await request.json().catch(() => ({}))) as { reportId?: unknown };
    const reportId = typeof body.reportId === "string" && body.reportId ? body.reportId : null;
    if (reportId && !isSafeId(reportId)) throw badRequest("Invalid report id.");
    const evidence = attachSessionEvidenceToReportById(user.id, evidenceId, reportId);
    return NextResponse.json({ evidence });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
