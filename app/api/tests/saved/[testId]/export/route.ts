import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireSameOrigin } from "@/lib/auth/api";
import { exportStudioTest } from "@/lib/testing/studio-service";
import { studioViewerFor } from "../../studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tests/saved/:testId/export — portable JSON export.
 * Contains definition + metadata only: no secrets (none exist), no runs,
 * no organization internals (§82).
 */

export async function GET(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { testId } = await context.params;
    const viewer = await studioViewerFor(request, false);
    const exported = exportStudioTest(viewer, testId);
    return new NextResponse(JSON.stringify(exported, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="extensionlab-test-${testId}.json"`,
      },
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
