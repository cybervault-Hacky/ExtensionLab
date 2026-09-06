import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireSameOrigin } from "@/lib/auth/api";
import { describeStudioSuite } from "@/lib/testing/studio-service";
import { studioViewerFor } from "../../saved/studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tests/suites/:suiteId — suite detail with ordered members. */

export async function GET(request: NextRequest, context: { params: Promise<{ suiteId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { suiteId } = await context.params;
    const viewer = await studioViewerFor(request, false);
    const detail = describeStudioSuite(viewer, suiteId);
    return NextResponse.json({
      suite: {
        id: detail.suite.id,
        name: detail.suite.name,
        description: detail.suite.description,
        failurePolicy: detail.suite.failure_policy,
        updatedAt: detail.suite.updated_at,
      },
      tests: detail.tests,
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
