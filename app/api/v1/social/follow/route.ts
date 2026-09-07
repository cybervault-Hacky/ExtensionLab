import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { followUser, unfollowUser, isFollowing } from "@/lib/db/repositories/community";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "tests:write", rateClass: "test", action: "org:tests:run" }, async (apiContext) => {
    try {
      const body = (await request.json().catch(() => null)) as { followedUserId?: unknown } | null;
      if (!body || typeof body.followedUserId !== "string") throw new AppError("INVALID_INPUT", { message: "followedUserId required." });
      const followerId = apiContext.principal.apiKey.created_by;
      const followedId = body.followedUserId.trim();
      if (followerId === followedId) throw new AppError("INVALID_INPUT", { message: "Cannot follow yourself." });
      if (isFollowing(followerId, followedId)) throw new AppError("CONFLICT", { message: "Already following." });
      followUser(followerId, followedId);
      return NextResponse.json({ status: "followed", followedUserId: followedId });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "tests:write", rateClass: "test", action: "org:tests:run" }, async (apiContext) => {
    try {
      const url = new URL(request.url);
      const followedId = url.searchParams.get("followedUserId");
      if (!followedId) throw new AppError("INVALID_INPUT", { message: "followedUserId query param required." });
      unfollowUser(apiContext.principal.apiKey.created_by, followedId);
      return NextResponse.json({ status: "unfollowed", followedUserId: followedId });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
