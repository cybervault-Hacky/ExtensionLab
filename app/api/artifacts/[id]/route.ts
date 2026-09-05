import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, assertEntitled, requireApiUser } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { readOwnedArtifact } from "@/lib/artifacts/service";
import { canUseAdvancedDiagnostics } from "@/lib/billing/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Private artifact download: session + ownership. Bytes are streamed from
 * storage through the app; storage keys or URLs are never exposed.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new AppError("NOT_FOUND", { message: "Artifact not found." });
    const artifact = await readOwnedArtifact(user.id, id);
    if (!artifact) throw new AppError("NOT_FOUND", { message: "Artifact not found." });
    // Screenshots are part of every plan; runtime logs and network evidence
    // downloads are an advanced-diagnostics entitlement.
    if (artifact.row.type !== "screenshot") assertEntitled(canUseAdvancedDiagnostics(user.id));
    const download = new URL(request.url).searchParams.get("download") === "1";
    const extension = artifact.row.content_type === "image/png" ? "png" : "json";
    return new NextResponse(Buffer.from(artifact.bytes), {
      status: 200,
      headers: {
        "content-type": artifact.row.content_type,
        "content-length": String(artifact.bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": `${download ? "attachment" : "inline"}; filename="artifact-${artifact.row.id}.${extension}"`,
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
