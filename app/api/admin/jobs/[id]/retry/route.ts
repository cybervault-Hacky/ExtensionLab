import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { requireAdmin, retryJobAdmin } from "@/lib/admin/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/admin/jobs/:id/retry — requeue a failed job (audited). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const { id } = await context.params;
    const job = retryJobAdmin(request.headers.get("x-request-id"), id);
    return NextResponse.json({ job });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
