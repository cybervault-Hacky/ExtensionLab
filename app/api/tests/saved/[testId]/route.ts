import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireSameOrigin } from "@/lib/auth/api";
import { describeStudioTest, duplicateStudioTest, updateStudioTest } from "@/lib/testing/studio-service";
import { studioViewerFor } from "../studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET    /api/tests/saved/:testId — full definition, version history and
 *          deterministic analytics (pass rate, avg duration, flaky suspect).
 * PATCH  /api/tests/saved/:testId — edit metadata/definition (bumps an
 *          immutable version when the definition changes) or change status
 *          (DRAFT/ACTIVE/ARCHIVED). Optimistic concurrency via expectedVersion.
 * POST   /api/tests/saved/:testId — duplicate (new identity, fresh history).
 */

export async function GET(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { testId } = await context.params;
    const viewer = await studioViewerFor(request, false);
    const detail = describeStudioTest(viewer, testId);
    return NextResponse.json({
      test: {
        id: detail.test.id,
        name: detail.test.name,
        description: detail.test.description,
        status: detail.test.status,
        version: detail.test.current_version,
        tags: JSON.parse(detail.test.tags_json) as string[],
        browsers: JSON.parse(detail.test.browser_targets_json) as string[],
        packageId: detail.test.package_id,
        packageVersion: detail.test.package_version,
        extensionId: detail.test.extension_id,
        createdAt: detail.test.created_at,
        updatedAt: detail.test.updated_at,
      },
      definition: detail.definition,
      versions: detail.versions,
      analytics: detail.analytics,
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { testId } = await context.params;
    const viewer = await studioViewerFor(request, true);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw badRequest("A JSON body is required.");
    const updated = await updateStudioTest(viewer, testId, {
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.description !== undefined ? { description: body.description as string } : {}),
      ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
      ...(body.browsers !== undefined ? { browserTargets: body.browsers as string[] } : {}),
      ...(body.definition !== undefined ? { definition: body.definition } : {}),
      ...(body.status !== undefined ? { status: body.status as "DRAFT" | "ACTIVE" | "ARCHIVED" } : {}),
      ...(body.expectedVersion !== undefined && typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}),
    });
    return NextResponse.json({ test: { id: updated.id, status: updated.status, version: updated.current_version, updatedAt: updated.updated_at } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const { testId } = await context.params;
    const viewer = await studioViewerFor(request, true);
    const copy = await duplicateStudioTest(viewer, testId);
    return NextResponse.json({ test: { id: copy.id, name: copy.name, status: copy.status, version: copy.current_version } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
