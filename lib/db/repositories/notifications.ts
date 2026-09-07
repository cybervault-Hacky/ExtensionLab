import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { NotificationRow, NotificationPreferenceRow } from "../schema/types";

export function createNotification(input: {
  id?: string;
  recipientUserId: string;
  actorUserId?: string | null;
  organizationId?: string | null;
  type: string;
  entityType: string;
  entityId: string;
  title: string;
  dataJson?: string;
  dedupeKey?: string;
}): NotificationRow {
  const db = getDb();
  const now = Date.now();
  const id = input.id ?? generateDbId("notif");
  const dedupe = input.dedupeKey ?? `${input.type}:${input.entityType}:${input.entityId}:${input.recipientUserId}`;
  // Dedup: ignore if same dedupe_key for same recipient exists within 1 hour (simple window)
  const existing = db.prepare("SELECT id FROM notifications WHERE recipient_user_id = ? AND dedupe_key = ? AND created_at > ?").get(
    input.recipientUserId, dedupe, now - 3600000,
  );
  if (existing) return getNotificationById((existing as { id: string }).id)!;
  db.prepare("INSERT INTO notifications (id, recipient_user_id, actor_user_id, organization_id, type, entity_type, entity_id, title, data_json, read_at, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, input.recipientUserId, input.actorUserId ?? null, input.organizationId ?? null, input.type, input.entityType, input.entityId, input.title, input.dataJson ?? "{}", null, dedupe, now,
  );
  return getNotificationById(id)!;
}

export function getNotificationById(id: string): NotificationRow | null {
  const r = getDb().prepare("SELECT * FROM notifications WHERE id = ?").get(id) as NotificationRow | undefined;
  return r ?? null;
}

export function listNotifications(recipientUserId: string, opts: { unreadOnly?: boolean; page?: number; limit?: number }) {
  const db = getDb();
  const page = Math.max(opts.page ?? 1, 1);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  let sql = "SELECT * FROM notifications WHERE recipient_user_id = ?";
  const params: (string | number)[] = [recipientUserId];
  if (opts.unreadOnly) {
    sql += " AND read_at IS NULL";
  }
  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, (page - 1) * limit);
  const items = db.prepare(sql).all(...params) as unknown as NotificationRow[];
  const totalRow = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE recipient_user_id = ?" + (opts.unreadOnly ? " AND read_at IS NULL" : "")).get(recipientUserId) as { c: number };
  return { items, total: totalRow.c };
}

export function getUnreadCount(recipientUserId: string): number {
  const r = getDb().prepare("SELECT COUNT(*) AS c FROM notifications WHERE recipient_user_id = ? AND read_at IS NULL").get(recipientUserId) as { c: number };
  return Number(r.c);
}

export function markNotificationRead(id: string, recipientUserId: string): boolean {
  const db = getDb();
  const res = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_user_id = ?").run(Date.now(), id, recipientUserId);
  return res.changes > 0;
}

export function markAllNotificationsRead(recipientUserId: string): number {
  const db = getDb();
  const res = db.prepare("UPDATE notifications SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL").run(Date.now(), recipientUserId);
  return Number(res.changes);
}

export function getNotificationPreferences(userId: string): NotificationPreferenceRow | null {
  const r = getDb().prepare("SELECT * FROM notification_preferences WHERE user_id = ?").get(userId) as NotificationPreferenceRow | undefined;
  return r ?? null;
}

export function setNotificationPreferences(userId: string, prefs: Partial<Omit<NotificationPreferenceRow, "user_id" | "created_at" | "updated_at">>): void {
  const db = getDb();
  const now = Date.now();
  const existing = getNotificationPreferences(userId);
  if (existing) {
    const keys = (Object.keys(prefs) as (keyof typeof prefs)[]).filter((k) => prefs[k] !== undefined);
    if (keys.length === 0) return;
    const setClauses = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => prefs[k] as number);
    db.prepare(`UPDATE notification_preferences SET ${setClauses}, updated_at = ? WHERE user_id = ?`).run(...values, now, userId);
  } else {
    db.prepare(`INSERT INTO notification_preferences (user_id, social_follow, social_like, social_comment, social_reply, social_mention, extension_updated, extension_released, test_completed, test_failed, ci_failed, ci_regression, report_updated, organization_invitation, organization_role_changed, organization_member_removed, email_enabled, created_at, updated_at) VALUES (?, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1, ?, ?)`)
      .run(userId, now, now);
  }
}
