import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { getProfileByUsername, createOrUpdateProfile } from "@/lib/db/repositories/community";
import { getProfileByUserId } from "@/lib/db/repositories/community";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ username: string }> }): Promise<NextResponse> {
  const { username } = await context.params;
  try {
    const profile = getProfileByUsername(username);
    if (!profile) throw new AppError("NOT_FOUND", { message: "Profile not found." });
    if (profile.profile_visibility === "private") {
      // Public route must not expose private profiles
      return NextResponse.json({ error: "Profile is private." }, { status: 404 });
    }
    const userId = profile.user_id;
    // Real follower/following counts from DB; no fake numbers
    const { getFollowers, getFollowing } = await import("@/lib/db/repositories/community");
    const followers = getFollowers(userId, 1).length; // approximate count via query? We'll do simple count
    const { getDb } = await import("@/lib/db/client");
    const followerCount = (getDb().prepare("SELECT COUNT(*) AS c FROM developer_follows WHERE followed_user_id = ?").get(userId) as { c: number }).c;
    const followingCount = (getDb().prepare("SELECT COUNT(*) AS c FROM developer_follows WHERE follower_user_id = ?").get(userId) as { c: number }).c;
    return NextResponse.json({
      username: profile.username,
      displayName: profile.display_name,
      bio: profile.bio,
      website: profile.website,
      developerTitle: profile.developer_title,
      location: profile.location,
      profileVisibility: profile.profile_visibility,
      avatarUrl: profile.avatar_url,
      followers: followerCount,
      following: followingCount,
    });
  } catch (error) {
    return apiErrorResponse(error, request.headers.get("x-request-id") ?? "unknown");
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ username: string }> }): Promise<NextResponse> {
  const { username } = await context.params;
  return withApiKey(request, { scope: "tests:write", rateClass: "test", action: "org:tests:run" }, async (apiContext) => {
    try {
      const profile = getProfileByUsername(username);
      if (!profile) throw new AppError("NOT_FOUND", { message: "Profile not found." });
      // Only the profile owner or organization admin can edit (simple ownership check)
      if (profile.user_id !== apiContext.principal.apiKey.created_by) {
        // For Phase 17, restrict edit to own profile; cross-user edits require org authorization tested later
        throw new AppError("FORBIDDEN", { message: "You can only edit your own profile." });
      }
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (body === null) throw new AppError("INVALID_INPUT", { message: "JSON body required." });
      const allowed = new Set(["username", "displayName", "bio", "website", "developerTitle", "location", "visibility", "avatarUrl"]);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new AppError("INVALID_INPUT", { message: `Unknown field: ${key}` });
      }
      if (body.username !== undefined && typeof body.username === "string") {
        const normalized = body.username.trim().toLowerCase();
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalized)) throw new AppError("INVALID_INPUT", { message: "Username must be 1-32 chars, start with letter, only a-z, 0-9, underscore." });
        // Check uniqueness excluding self
        const other = getProfileByUsername(normalized);
        if (other && other.user_id !== profile.user_id) throw new AppError("CONFLICT", { message: "Username taken." });
        body.username = normalized;
      }
      if (body.website !== undefined && typeof body.website === "string" && body.website.trim() !== "") {
        const url = body.website.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) throw new AppError("INVALID_INPUT", { message: "Website must start with http:// or https://" });
        if (url.length > 512) throw new AppError("INVALID_INPUT", { message: "Website too long." });
        // Basic URL validation; reject javascript/data URLs
        if (/^[\s]*javascript:/i.test(url) || /^[\s]*data:/i.test(url)) throw new AppError("INVALID_INPUT", { message: "Unsafe URL." });
      }
      const updated = createOrUpdateProfile({
        userId: profile.user_id,
        username: (body.username as string | undefined) ?? profile.username,
        displayName: (body.displayName as string | undefined) ?? profile.display_name,
        bio: (body.bio as string | undefined) ?? profile.bio,
        website: (body.website as string | undefined) ?? profile.website ?? undefined,
        developerTitle: (body.developerTitle as string | undefined) ?? profile.developer_title ?? undefined,
        location: (body.location as string | undefined) ?? profile.location ?? undefined,
        visibility: (body.visibility as string | undefined) ?? profile.profile_visibility,
        avatarUrl: (body.avatarUrl as string | undefined) ?? profile.avatar_url ?? undefined,
      });
      return NextResponse.json({ profile: { username: updated.username, displayName: updated.display_name, bio: updated.bio, visibility: updated.profile_visibility } });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
