import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { UserRow } from "../schema/types";

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  name: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export function createUser(input: CreateUserInput): UserRecord {
  const db = getDb();
  const email = input.email.trim().toLowerCase();
  const now = Date.now();
  const id = generateDbId("usr");
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, email, input.passwordHash, input.name, now, now);
  return {
    id,
    email,
    name: input.name,
    avatarUrl: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

export function findUserByEmail(email: string): UserRow | null {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  return (
    (db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(normalized) as UserRow | undefined) ?? null
  );
}

export function findUserById(id: string): UserRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ??
    null
  );
}

export function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function updateUserProfile(
  id: string,
  input: { name: string; email: string },
): UserRecord {
  const db = getDb();
  db.prepare(
    `UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?`,
  ).run(input.name, input.email, Date.now(), id);
  const row = findUserById(id);
  if (!row) throw new Error("User not found.");
  return toUserRecord(row);
}

export function updateUserPassword(id: string, passwordHash: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
  ).run(passwordHash, Date.now(), id);
}

export function deleteUser(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}
