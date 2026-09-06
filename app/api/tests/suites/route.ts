import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireSameOrigin } from "@/lib/auth/api";
import { createStudioSuite, listStudioSuites } from "@/lib/testing/studio-service";
import { studioViewerFor } from "../saved/studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/tests/suites — the viewer's saved suites.
 * POST /api/tests/suites — create a suite with deterministic ordering
 *                          (array order), explicit backwards-only dependencies
 *                          and a stop/continue failure policy (§24–§26).
 */

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const viewer = await studioViewerFor(request, false);
    const suites = listStudioSuites(viewer);
    return NextResponse.json({
      suites: suites.map((suite) => ({
        id: suite.id,
        name: suite.name,
        description: suite.description,
        failurePolicy: suite.failure_policy,
        tests: suite.tests,
        updatedAt: suite.updated_at,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const viewer = await studioViewerFor(request, true);
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      description?: unknown;
      failurePolicy?: unknown;
      testIds?: unknown;
      dependencies?: unknown;
    } | null;
    if (!body || typeof body.name !== "string") throw badRequest("name is required.");
    if (!Array.isArray(body.testIds)) throw badRequest("testIds must be an array.");
    const dependencies =
      body.dependencies && typeof body.dependencies === "object" && !Array.isArray(body.dependencies)
        ? (body.dependencies as Record<string, string[]>)
        : {};
    const suite = createStudioSuite(viewer, {
      name: body.name,
      description: typeof body.description === "string" ? body.description : "",
      failurePolicy: body.failurePolicy === "continue" ? "continue" : "stop",
      testIds: body.testIds as string[],
      dependencies,
    });
    return NextResponse.json({ suite: { id: suite.id, name: suite.name, failurePolicy: suite.failure_policy } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
