import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { createStudioTest, listStudioTests } from "@/lib/testing/studio-service";
import { studioViewerFor } from "./studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Test Automation Studio — saved tests (Phase 15).
 *
 * GET  /api/tests/saved — server-side paginated list with search and filters
 *                        (name/search, status, browser, tag, suite).
 * POST /api/tests/saved — create a DRAFT saved test bound to an uploaded
 *                        package. The definition is validated against the
 *                         Phase 4 action/assertion allowlist before storage.
 */

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const viewer = await studioViewerFor(request, false);
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status = statusParam === "DRAFT" || statusParam === "ACTIVE" || statusParam === "ARCHIVED" ? statusParam : undefined;
    const listed = listStudioTests(viewer, {
      page: Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1),
      limit: Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50),
      ...(url.searchParams.get("search")?.trim() ? { search: url.searchParams.get("search")!.trim().slice(0, 120) } : {}),
      ...(status ? { status } : {}),
      ...(url.searchParams.get("tag")?.trim() ? { tag: url.searchParams.get("tag")!.trim() } : {}),
      ...(url.searchParams.get("browser") ? { browserId: url.searchParams.get("browser")! } : {}),
      ...(url.searchParams.get("suiteId") ? { suiteId: url.searchParams.get("suiteId")! } : {}),
    });
    return NextResponse.json({
      tests: listed.items.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        version: row.current_version,
        tags: JSON.parse(row.tags_json) as string[],
        browsers: JSON.parse(row.browser_targets_json) as string[],
        packageId: row.package_id,
        extensionId: row.extension_id,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
      })),
      pagination: { page: listed.page, limit: listed.limit, total: listed.total },
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
      tags?: unknown;
      browsers?: unknown;
      definition?: unknown;
      packageId?: unknown;
    } | null;
    if (!body || typeof body.packageId !== "string") throw badRequest("packageId is required.");
    if (typeof body.name !== "string") throw badRequest("name is required.");
    const created = await createStudioTest(
      viewer,
      {
        name: body.name,
        description: typeof body.description === "string" ? body.description : "",
        tags: Array.isArray(body.tags) ? body.tags : [],
        browserTargets: Array.isArray(body.browsers) ? body.browsers : ["chromium"],
        definition: body.definition,
      },
      body.packageId,
    );
    return NextResponse.json({ test: { id: created.id, name: created.name, status: created.status, version: created.current_version } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
