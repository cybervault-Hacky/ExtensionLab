import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireSameOrigin } from "@/lib/auth/api";
import { runStudioSuite } from "@/lib/testing/studio-service";
import { isBrowserId, type BrowserId } from "@/lib/browsers/types";
import { studioViewerFor } from "../../../saved/studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tests/suites/:suiteId/run — run the whole suite as one queued run:
 * deterministic member order, explicit dependencies, suite failure policy.
 */

export async function POST(request: NextRequest, context: { params: Promise<{ suiteId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { suiteId } = await context.params;
    const viewer = await studioViewerFor(request, true);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null;
    const browserId = isBrowserId(body?.browser) ? (body?.browser as BrowserId) : undefined;
    const created = await runStudioSuite(viewer, suiteId, {
      source: "interactive",
      ...(browserId ? { browserId } : {}),
      ...(typeof body?.testUrl === "string" && body.testUrl.trim() !== "" ? { testUrl: body.testUrl.trim() } : {}),
    });
    return NextResponse.json({ runId: created.runId, jobId: created.jobId, token: created.token, members: created.members, status: "queued" }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
