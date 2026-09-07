import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { UserProfileRow, DeveloperFollowRow, SocialPostRow, PostLikeRow, PostCommentRow, ContentReportRow, UserBlockRow, SavedItemRow } from "../schema/types";
import { notifyFollow, notifyPostLiked, notifyPostCommented, notifyMentioned } from "@/lib/notifications/service";

export function getProfileByUserId(userId: string): UserProfileRow | null {
  const r = getDb().prepare("SELECT * FROM user_profiles WHERE user_id = ?").get(userId) as UserProfileRow | undefined;
  return r ?? null;
}

export function getProfileByUsername(username: string): UserProfileRow | null {
  const r = getDb().prepare("SELECT * FROM user_profiles WHERE username = ?").get(username.toLowerCase()) as UserProfileRow | undefined;
  return r ?? null;
}

export function createOrUpdateProfile(input: {
  userId: string; username: string; displayName?: string; bio?: string; website?: string; developerTitle?: string; location?: string; visibility?: string; avatarUrl?: string;
}): UserProfileRow {
  const db = getDb();
  const now = Date.now();
  const existing = getProfileByUserId(input.userId);
  if (existing) {
    db.prepare("UPDATE user_profiles SET username = ?, display_name = ?, bio = ?, website = ?, developer_title = ?, location = ?, profile_visibility = ?, avatar_url = ?, updated_at = ? WHERE user_id = ?").run(
      input.username.toLowerCase(), input.displayName ?? existing.display_name, input.bio ?? existing.bio, input.website ?? existing.website ?? null, input.developerTitle ?? existing.developer_title ?? null, input.location ?? existing.location ?? null, input.visibility ?? existing.profile_visibility, input.avatarUrl ?? existing.avatar_url ?? null, now, input.userId,
    );
  } else {
    db.prepare("INSERT INTO user_profiles (user_id, username, display_name, bio, website, developer_title, location, profile_visibility, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      input.userId, input.username.toLowerCase(), input.displayName ?? "", input.bio ?? "", input.website ?? null, input.developerTitle ?? null, input.location ?? null, input.visibility ?? "public", input.avatarUrl ?? null, now, now,
    );
  }
  return getProfileByUserId(input.userId)!;
}

export function followUser(followerId: string, followedId: string): void {
  if (followerId === followedId) throw new Error("Cannot follow yourself.");
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO developer_follows (follower_user_id, followed_user_id, created_at) VALUES (?, ?, ?)").run(followerId, followedId, Date.now());
  notifyFollow(followedId, followerId);
}

export function unfollowUser(followerId: string, followedId: string): void {
  getDb().prepare("DELETE FROM developer_follows WHERE follower_user_id = ? AND followed_user_id = ?").run(followerId, followedId);
}

export function getFollowers(userId: string, limit = 20): string[] {
  return getDb().prepare("SELECT follower_user_id FROM developer_follows WHERE followed_user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit).map((r: unknown) => (r as { follower_user_id: string }).follower_user_id);
}

export function getFollowing(userId: string, limit = 20): string[] {
  return getDb().prepare("SELECT followed_user_id FROM developer_follows WHERE follower_user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit).map((r: unknown) => (r as { followed_user_id: string }).followed_user_id);
}

export function isFollowing(followerId: string, followedId: string): boolean {
  const r = getDb().prepare("SELECT 1 FROM developer_follows WHERE follower_user_id = ? AND followed_user_id = ?").get(followerId, followedId);
  return r !== undefined;
}

export function createPost(input: { id: string; authorUserId: string; content: string; visibility?: string; extensionId?: string | null }): SocialPostRow {
  const db = getDb();
  const now = Date.now();
  db.prepare("INSERT INTO social_posts (id, author_user_id, content_text, visibility, attachment_extension_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    input.id, input.authorUserId, input.content, input.visibility ?? "public", input.extensionId ?? null, now, now,
  );
  return getPostById(input.id)!;
}

export function getPostById(id: string): SocialPostRow | null {
  const r = getDb().prepare("SELECT * FROM social_posts WHERE id = ?").get(id) as SocialPostRow | undefined;
  return r ?? null;
}

export function updatePost(id: string, content: string): void {
  getDb().prepare("UPDATE social_posts SET content_text = ?, updated_at = ? WHERE id = ?").run(content, Date.now(), id);
}

export function deletePost(id: string): void {
  getDb().prepare("DELETE FROM social_posts WHERE id = ?").run(id);
}

export function listPublicPostsByAuthor(userId: string, limit = 20): SocialPostRow[] {
  return getDb().prepare("SELECT * FROM social_posts WHERE author_user_id = ? AND visibility = 'public' ORDER BY created_at DESC LIMIT ?").all(userId, limit) as unknown as SocialPostRow[];
}

export function likePost(userId: string, postId: string): void {
  getDb().prepare("INSERT OR IGNORE INTO post_likes (user_id, post_id, created_at) VALUES (?, ?, ?)").run(userId, postId, Date.now());
  const post = getPostById(postId);
  if (post && post.author_user_id !== userId) notifyPostLiked(post.author_user_id, userId, postId);
}

export function unlikePost(userId: string, postId: string): void {
  getDb().prepare("DELETE FROM post_likes WHERE user_id = ? AND post_id = ?").run(userId, postId);
}

export function getPostLikesCount(postId: string): number {
  const r = getDb().prepare("SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?").get(postId) as { c: number };
  return r.c;
}

export function createComment(input: { id: string; postId: string; authorUserId: string; content: string; parentCommentId?: string | null }): PostCommentRow {
  const db = getDb();
  const now = Date.now();
  db.prepare("INSERT INTO post_comments (id, post_id, author_user_id, content_text, parent_comment_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    input.id, input.postId, input.authorUserId, input.content, input.parentCommentId ?? null, "active", now, now,
  );
  const postRow = getPostById(input.postId);
  if (postRow && postRow.author_user_id !== input.authorUserId) notifyPostCommented(postRow.author_user_id, input.authorUserId, input.postId, input.id);
  const r = getDb().prepare("SELECT * FROM post_comments WHERE id = ?").get(input.id) as PostCommentRow | undefined;
  return r!;
}

export function listCommentsByPost(postId: string, limit = 50): PostCommentRow[] {
  return getDb().prepare("SELECT * FROM post_comments WHERE post_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?").all(postId, limit) as unknown as PostCommentRow[];
}

export function reportContent(input: { id: string; reporterId: string; targetType: string; targetId: string; reason: string }): ContentReportRow {
  const db = getDb();
  const now = Date.now();
  db.prepare("INSERT INTO content_reports (id, reporter_user_id, target_type, target_id, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    input.id, input.reporterId, input.targetType, input.targetId, input.reason, "active", now, now,
  );
  return getDb().prepare("SELECT * FROM content_reports WHERE id = ?").get(input.id) as unknown as ContentReportRow;
}

export function blockUser(blockerId: string, blockedId: string): void {
  if (blockerId === blockedId) throw new Error("Cannot block yourself.");
  getDb().prepare("INSERT OR IGNORE INTO user_blocks (blocker_user_id, blocked_user_id, created_at) VALUES (?, ?, ?)").run(blockerId, blockedId, Date.now());
}

export function unblockUser(blockerId: string, blockedId: string): void {
  getDb().prepare("DELETE FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?").run(blockerId, blockedId);
}

export function isBlocked(blockerId: string, blockedId: string): boolean {
  return getDb().prepare("SELECT 1 FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?").get(blockerId, blockedId) !== undefined;
}

export function saveItem(userId: string, itemType: string, itemId: string): void {
  getDb().prepare("INSERT OR IGNORE INTO saved_items (user_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)").run(userId, itemType, itemId, Date.now());
}

export function unsaveItem(userId: string, itemType: string, itemId: string): void {
  getDb().prepare("DELETE FROM saved_items WHERE user_id = ? AND item_type = ? AND item_id = ?").run(userId, itemType, itemId);
}
