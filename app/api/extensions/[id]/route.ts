import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ApiError, apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { deleteExtension, getOwnedExtension } from "@/lib/db/repositories/extensions";
import { getLatestSnapshot, listSnapshots } from "@/lib/db/repositories/snapshots";
import { listTestRunsForExtension } from "@/lib/db/repositories/test-runs";
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
    if (!isSafeId(id)) throw new ApiError(404, "not_found", "Extension not found.");
    const extension = getOwnedExtension(user.id, id);
    if (!extension) throw new ApiError(404, "not_found", "Extension not found.");
    return NextResponse.json({
      extension,
      latestSnapshot: getLatestSnapshot(id),
      snapshots: listSnapshots(id, 20),
      recentRuns: listTestRunsForExtension(id, 10),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new ApiError(404, "not_found", "Extension not found.");
    const extension = getOwnedExtension(user.id, id);
    if (!extension) throw new ApiError(404, "not_found", "Extension not found.");
    deleteExtension(user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
