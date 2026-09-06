import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { captureFrame, captureScreenshotArtifact } from "@/lib/interactive/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Controlled frame transport (Phase 11).
 *
 * GET returns the latest browser frame as PNG (rate-limited per session;
 * early requests receive the cached frame so the container never renders
 * faster than the deployment allows). This is the only way the web client can
 * see the browser: no VNC, no CDP websocket, no container ports are exposed.
 *
 * POST captures the current page frame as a retained screenshot artifact.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");
    const target = new URL(request.url).searchParams.get("target") === "popup" ? "popup" : "page";
    const frame = await captureFrame(user.id, id, target);
    if (!frame) {
      return NextResponse.json({ error: { message: "No frame is available yet." } }, { status: 409 });
    }
    return new NextResponse(Buffer.from(frame.bytes), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");
    const body = (await request.json().catch(() => null)) as { label?: unknown } | null;
    const label = body?.label !== undefined && typeof body.label === "string" ? body.label : null;
    const artifact = await captureScreenshotArtifact(user.id, id, label);
    return NextResponse.json({ artifact }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
