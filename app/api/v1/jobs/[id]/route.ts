import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/jobs/:id — job status for the API key's organization (safe projection). */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  return withApiKey(request, { scope: "tests:read", rateClass: "read" }, async (apiContext) => {
    const row = getDb()
      .prepare("SELECT id, type, status, attempts, max_attempts, error_code, resource_type, resource_id, created_at, started_at, finished_at FROM jobs WHERE id = ? AND organization_id = ?")
      .get(id, apiContext.principal.organizationId) as
      | { id: string; type: string; status: string; attempts: number; max_attempts: number; error_code: string | null; resource_type: string | null; resource_id: string | null; created_at: number; started_at: number | null; finished_at: number | null }
      | undefined;
    if (!row) throw new AppError("NOT_FOUND");
    return NextResponse.json({
      job: {
        id: row.id,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        errorCode: row.error_code,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      },
    });
  });
}
