import { createNotification, getNotificationPreferences } from "@/lib/db/repositories/notifications";
import { getDb } from "@/lib/db/client";

function shouldNotify(recipientUserId: string, type: string, prefs?: ReturnType<typeof getNotificationPreferences>): boolean {
  if (!prefs) prefs = getNotificationPreferences(recipientUserId);
  if (!prefs) return true; // default conservative
  switch (type) {
    case "FOLLOWED": return prefs.social_follow === 1;
    case "POST_LIKED": return prefs.social_like === 1;
    case "POST_COMMENTED": return prefs.social_comment === 1;
    case "COMMENT_REPLIED": return prefs.social_reply === 1;
    case "MENTIONED": return prefs.social_mention === 1;
    case "EXTENSION_UPDATED": return prefs.extension_updated === 1;
    case "VERSION_RELEASED": return prefs.extension_released === 1;
    case "TEST_COMPLETED": return prefs.test_completed === 1;
    case "TEST_FAILED": return prefs.test_failed === 1;
    case "CI_COMPLETED": return prefs.test_completed === 1; // reuse
    case "CI_FAILED": return prefs.test_failed === 1;
    case "CI_REGRESSION": return prefs.ci_regression === 1;
    case "REPORT_CREATED": return prefs.report_updated === 1;
    case "ORG_INVITATION": return prefs.organization_invitation === 1;
    case "ORG_ROLE_CHANGED": return prefs.organization_role_changed === 1;
    case "ORG_MEMBER_REMOVED": return prefs.organization_member_removed === 1;
    default: return true;
  }
}

export function notifyFollow(recipientUserId: string, actorUserId: string): void {
  if (recipientUserId === actorUserId) return;
  if (getDb().prepare("SELECT 1 FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?").get(recipientUserId, actorUserId)) return;
  const prefs = getNotificationPreferences(recipientUserId);
  if (!shouldNotify(recipientUserId, "FOLLOWED", prefs)) return;
  const profileRow = getDb().prepare("SELECT username FROM user_profiles WHERE user_id = ?").get(actorUserId) as { username: string } | undefined;
  createNotification({
    recipientUserId,
    actorUserId,
    type: "FOLLOWED",
    entityType: "user",
    entityId: actorUserId,
    title: "New follower",
    dataJson: JSON.stringify({ username: profileRow?.username ?? "developer" }),
    dedupeKey: `FOLLOWED:user:${actorUserId}:${recipientUserId}`,
  });
}

export function notifyPostLiked(recipientUserId: string, actorUserId: string, postId: string): void {
  if (recipientUserId === actorUserId) return;
  if (getDb().prepare("SELECT 1 FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?").get(recipientUserId, actorUserId)) return;
  const post = getDb().prepare("SELECT * FROM social_posts WHERE id = ?").get(postId) as { visibility: string; author_user_id: string } | undefined;
  if (!post || post.visibility !== "public") return;
  const prefs = getNotificationPreferences(recipientUserId);
  if (!shouldNotify(recipientUserId, "POST_LIKED", prefs)) return;
  createNotification({
    recipientUserId,
    actorUserId,
    type: "POST_LIKED",
    entityType: "post",
    entityId: postId,
    title: "Your post was liked",
    dataJson: JSON.stringify({ postId }),
    dedupeKey: `POST_LIKED:post:${postId}:${actorUserId}:${recipientUserId}`,
  });
}

export function notifyPostCommented(recipientUserId: string, actorUserId: string, postId: string, commentId?: string): void {
  if (recipientUserId === actorUserId) return;
  if (getDb().prepare("SELECT 1 FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?").get(recipientUserId, actorUserId)) return;
  const post = getDb().prepare("SELECT * FROM social_posts WHERE id = ?").get(postId) as { visibility: string; author_user_id: string } | undefined;
  if (!post || post.visibility !== "public") return;
  const prefs = getNotificationPreferences(recipientUserId);
  if (!shouldNotify(recipientUserId, "POST_COMMENTED", prefs)) return;
  createNotification({
    recipientUserId,
    actorUserId,
    type: "POST_COMMENTED",
    entityType: "post",
    entityId: postId,
    title: "New comment on your post",
    dataJson: JSON.stringify({ postId, commentId: commentId ?? null }),
    dedupeKey: `POST_COMMENTED:post:${postId}:${actorUserId}:${recipientUserId}`,
  });
}

export function notifyMentioned(recipientUserId: string, actorUserId: string, postId: string): void {
  if (recipientUserId === actorUserId) return;
  if (getDb().prepare("SELECT 1 FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?").get(recipientUserId, actorUserId)) return;
  const post = getDb().prepare("SELECT * FROM social_posts WHERE id = ?").get(postId) as { visibility: string; author_user_id: string } | undefined;
  if (!post || post.visibility !== "public") return;
  const prefs = getNotificationPreferences(recipientUserId);
  if (!shouldNotify(recipientUserId, "MENTIONED", prefs)) return;
  createNotification({
    recipientUserId,
    actorUserId,
    type: "MENTIONED",
    entityType: "post",
    entityId: postId,
    title: "You were mentioned",
    dataJson: JSON.stringify({ postId }),
    dedupeKey: `MENTIONED:post:${postId}:${actorUserId}:${recipientUserId}`,
  });
}
