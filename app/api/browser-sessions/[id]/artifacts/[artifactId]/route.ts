import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { getSessionArtifactById, getOwnedSession } from "@/lib/db/repositories/browser-sessions";
import { getStorage } from "@/lib/storage/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams a session screenshot artifact to its owner. Storage keys are never
 * exposed; expired artifacts are gone (410).
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; artifactId: string }> },
): Promise<Response> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id, artifactId } = await context.params;
    if (!isSafeId(id) || !isSafeId(artifactId)) throw badRequest("Invalid id.");

    const session = getOwnedSession(user.id, id);
    if (!session) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
    const artifact = getSessionArtifactById(artifactId);
    if (!artifact || artifact.session_id !== id || artifact.user_id !== user.id) {
      throw new AppError("NOT_FOUND", { message: "Artifact not found." });
    }
    if (artifact.expires_at <= Date.now()) {
      throw new AppError("NOT_FOUND", { message: "This screenshot has expired and is no longer available." });
    }

    const bytes = await getStorage().get(artifact.storage_key);
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": artifact.content_type,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": `${download ? "attachment" : "inline"}; filename="session-${id}-${artifact.id}.png"`,
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
