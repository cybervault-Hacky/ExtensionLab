import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { createPost, getPostById, updatePost, deletePost, listPublicPostsByAuthor } from "@/lib/db/repositories/community";
import { getProfileByUserId } from "@/lib/db/repositories/community";
import { AppError } from "@/lib/observability/errors";
import { notifyMentionsFromPost } from "@/lib/notifications/mentions";
import { generateSessionToken } from "@/lib/runtime/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "tests:write", rateClass: "test", action: "org:tests:run" }, async (apiContext) => {
    try {
      const body = (await request.json().catch(() => null)) as { content?: unknown; visibility?: unknown; extensionId?: unknown } | null;
      if (!body || typeof body.content !== "string") throw new AppError("INVALID_INPUT", { message: "content required." });
      const content = body.content.trim();
      if (content.length === 0 || content.length > 2000) throw new AppError("INVALID_INPUT", { message: "Content must be 1-2000 chars." });
      const visibility = (body.visibility === "public" || body.visibility === "private") ? body.visibility : "public";
      const extensionId = (typeof body.extensionId === "string" && body.extensionId.length > 0) ? body.extensionId : null;
      const authorId = apiContext.principal.apiKey.created_by;
      // Visibility must not be set to public if user's profile is private? Allow independent visibility.
      const post = createPost({ id: generateSessionToken(), authorUserId: authorId, content, visibility, extensionId });
      try { notifyMentionsFromPost(post.id, authorId, content); } catch { /* notification failure must not break core action */ }
      return NextResponse.json({ post: { id: post.id, content: post.content_text, visibility: post.visibility, createdAt: post.created_at } }, { status: 201 });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ postId: string }> }): Promise<NextResponse> {
  const { postId } = await context.params;
  try {
    const post = getPostById(postId);
    if (!post) throw new AppError("NOT_FOUND", { message: "Post not found." });
    if (post.visibility === "private") {
      // Additional authorization could be added; for Phase 17, require auth or owner
      return NextResponse.json({ error: "Post is private." }, { status: 404 });
    }
    const profile = getProfileByUserId(post.author_user_id);
    return NextResponse.json({
      id: post.id,
      content: post.content_text,
      visibility: post.visibility,
      author: { username: profile?.username ?? null, displayName: profile?.display_name ?? null },
      createdAt: post.created_at,
    });
  } catch (error) {
    return apiErrorResponse(error, request.headers.get("x-request-id") ?? "unknown");
  }
}
