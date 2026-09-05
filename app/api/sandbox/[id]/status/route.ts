import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxManager } from "@/lib/runtime/sandbox-manager-instance";
import { getSandboxToken } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireApiUser(request);
    const { id } = await context.params;
    const info = getSandboxManager().getInfo(id, getSandboxToken(request));
    return NextResponse.json(info);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
