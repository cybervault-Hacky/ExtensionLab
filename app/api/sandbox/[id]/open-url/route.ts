import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxManager } from "@/lib/runtime/sandbox-manager-instance";
import { getSandboxToken, validateIncomingTestUrl } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    requireApiUser(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => null) as { url?: string } | null;
    const urlResult = await validateIncomingTestUrl(body?.url ?? "");
    if (!urlResult.ok || !urlResult.url) {
      return NextResponse.json({ error: { message: urlResult.reason ?? "This URL cannot be tested from the sandbox." } }, { status: 400 });
    }
    const info = await getSandboxManager().openUrl(id, getSandboxToken(request), urlResult.url);
    return NextResponse.json(info);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
