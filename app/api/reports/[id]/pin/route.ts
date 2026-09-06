import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { getOwnedReport, setReportPinned } from "@/lib/db/repositories/reports";
import { isSafeId } from "@/lib/auth/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 13: pin/unpin a report. A pinned report's linked artifacts are exempt
 * from retention deletion until the pin is removed. Ownership-checked; org
 * visibility rules match the report GET route.
 */
async function setPin(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
  pinned: boolean,
): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new ApiError(404, "not_found", "Report not found.");
    if (!getOwnedReport(user.id, id)) throw new ApiError(404, "not_found", "Report not found.");
    const updated = setReportPinned(user.id, id, pinned);
    if (!updated) throw new ApiError(404, "not_found", "Report not found.");
    return NextResponse.json({ id: updated.id, pinned: pinned, pinnedAt: updated.pinned_at ?? null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return setPin(request, context, true);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return setPin(request, context, false);
}
