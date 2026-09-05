import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { PasswordResetRow } from "../schema/types";

export function createPasswordReset(input: {
  userId: string;
  tokenHash: string;
  expiresAt: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    generateDbId("prs"),
    input.userId,
    input.tokenHash,
    Date.now(),
    input.expiresAt,
  );
}

export function findPasswordReset(tokenHash: string): PasswordResetRow | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM password_resets WHERE token_hash = ?")
      .get(tokenHash) as PasswordResetRow | undefined) ?? null
  );
}

export function markPasswordResetUsed(id: string, at: number): void {
  const db = getDb();
  db.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(at, id);
}

export function invalidateUserPasswordResets(userId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
  ).run(Date.now(), userId);
}

export function deleteExpiredPasswordResets(): void {
  const db = getDb();
  db.prepare("DELETE FROM password_resets WHERE expires_at <= ?").run(Date.now());
}
