import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { cancelJobAdmin, requireAdmin } from "@/lib/admin/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/admin/jobs/:id/cancel — cancel a queued/retrying job or request cooperative cancel (audited). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const { id } = await context.params;
    const job = cancelJobAdmin(request.headers.get("x-request-id"), id);
    return NextResponse.json({ job });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
