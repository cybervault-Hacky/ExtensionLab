import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getTestRunManager } from "@/lib/testing/manager-instance";
import { getSandboxToken } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  try {
    requireApiUser(request);
    const { runId } = await context.params;
    const data = getTestRunManager().getResults(runId, getSandboxToken(request));
    return NextResponse.json(data);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
