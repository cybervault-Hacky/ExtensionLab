import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireSameOrigin } from "@/lib/auth/api";
import { importStudioTest } from "@/lib/testing/studio-service";
import { studioViewerFor } from "../studio-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tests/saved/import — import a previously exported test.
 *
 * The file is untrusted input: size-bounded, schema-validated, every action/
 * assertion/selector/variable re-validated, unknown fields rejected. Imports
 * always land as a DRAFT owned by the importer — never silently overwrite an
 * existing test (§82).
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const viewer = await studioViewerFor(request, true);
    const body = (await request.json().catch(() => null)) as { json?: unknown; packageId?: unknown } | null;
    if (!body || typeof body.json !== "string") throw badRequest("json (the exported file's text) is required.");
    if (typeof body.packageId !== "string") throw badRequest("packageId is required (the package the test will run against).");
    const imported = await importStudioTest(viewer, body.json, body.packageId);
    return NextResponse.json({ test: { id: imported.id, name: imported.name, status: imported.status, version: imported.current_version } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
