import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { requireAdmin, setWorkerStateAdmin } from "@/lib/admin/service";
import { badRequest } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/workers/:ref/state — high-level lifecycle control ONLY
 * (§57): body {desired: "running"|"draining"|"disabled"}. Draining stops new
 * claims and lets active jobs finish; disabling also blocks re-enable-free
 * restarts until an operator re-enables. Audited. No shell, no exec.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ ref: string }> }): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const { ref } = await context.params;
    const body = (await request.json().catch(() => null)) as { desired?: unknown } | null;
    if (!body || (body.desired !== "running" && body.desired !== "draining" && body.desired !== "disabled")) {
      throw badRequest('desired must be "running", "draining" or "disabled".');
    }
    const result = setWorkerStateAdmin(request.headers.get("x-request-id"), ref, body.desired);
    return NextResponse.json({ worker: result });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
