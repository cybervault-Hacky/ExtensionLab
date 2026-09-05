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
): Promise<Response> {
  try {
    requireApiUser(request);
    const { id } = await context.params;
    const bytes = await getSandboxManager().screenshot(id, getSandboxToken(request));
    if (!bytes || bytes.length === 0) {
      return NextResponse.json({ error: { message: "Screenshot is not available yet." } }, { status: 409 });
    }
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "image/png", "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
