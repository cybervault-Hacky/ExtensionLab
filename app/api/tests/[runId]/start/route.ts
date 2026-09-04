import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getTestRunManager } from "@/lib/testing/manager-instance";
import { getSandboxToken, errorResponse } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  try {
    const { runId } = await context.params;
    const info = await getTestRunManager().start(runId, getSandboxToken(request));
    return NextResponse.json(info);
  } catch (error) {
    return errorResponse(error);
  }
}
