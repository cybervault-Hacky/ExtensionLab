import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { SessionRow } from "../schema/types";
import type { UserRow } from "../schema/types";

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
  userAgent: string | null;
  ipAddress: string | null;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  now?: number;
  ttlMs?: number;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export function createSession(input: CreateSessionInput): SessionRecord {
  const db = getDb();
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? 1000 * 60 * 60 * 24 * 7;
  const id = generateDbId("ses");
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_active_at, user_agent, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.tokenHash,
    now,
    now + ttl,
    now,
    input.userAgent ?? null,
    input.ipAddress ?? null,
  );
  return {
    id,
    userId: input.userId,
    createdAt: now,
    expiresAt: now + ttl,
    lastActiveAt: now,
    userAgent: input.userAgent ?? null,
    ipAddress: input.ipAddress ?? null,
  };
}

export function findSessionByTokenHash(
  tokenHash: string,
): (SessionRow & { user: UserRow }) | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         s.id, s.user_id, s.token_hash, s.created_at, s.expires_at,
         s.last_active_at, s.user_agent, s.ip_address,
         u.email, u.password_hash, u.name,
         u.avatar_url AS user_avatar_url, u.status AS user_status,
         u.created_at AS user_created_at, u.updated_at AS user_updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as
    | (SessionRow & {
        email: string;
        password_hash: string;
        name: string;
        user_avatar_url: string | null;
        user_status: string;
        user_created_at: number;
        user_updated_at: number;
      })
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    token_hash: row.token_hash,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_active_at: row.last_active_at,
    user_agent: row.user_agent,
    ip_address: row.ip_address,
    user: {
      id: row.user_id,
      email: row.email,
      password_hash: row.password_hash,
      name: row.name,
      avatar_url: row.user_avatar_url,
      status: row.user_status,
      created_at: row.user_created_at,
      updated_at: row.user_updated_at,
    },
  };
}

export function touchSession(id: string, at: number): void {
  const db = getDb();
  db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`).run(at, id);
}

export function deleteSession(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function deleteAllSessionsForUser(userId: string, exceptId?: string): void {
  const db = getDb();
  if (exceptId) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").run(
      userId,
      exceptId,
    );
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export function listActiveSessions(userId: string): SessionRecord[] {
  const db = getDb();
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_active_at DESC LIMIT 50`,
    )
    .all(userId, now) as unknown as SessionRow[];
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastActiveAt: row.last_active_at,
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
  }));
}

export function cleanupExpiredSessions(): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}
