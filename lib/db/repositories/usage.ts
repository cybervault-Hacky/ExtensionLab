import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { UsageEventRow } from "../schema/types";

export type UsageKind = "analysis" | "test_run";

export function recordUsage(userId: string, kind: UsageKind): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO usage_events (id, user_id, kind, created_at) VALUES (?, ?, ?, ?)",
  ).run(generateDbId("use"), userId, kind, Date.now());
}

export function countUsageThisMonth(userId: string, kind: UsageKind): number {
  const db = getDb();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS total FROM usage_events WHERE user_id = ? AND kind = ? AND created_at >= ?",
      )
      .get(userId, kind, start) as { total: number }
  ).total;
}

export function usageLimitReached(userId: string, kind: UsageKind, limit: number): boolean {
  return countUsageThisMonth(userId, kind) >= limit;
}

export function listUsageEvents(userId: string, limit = 100): UsageEventRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM usage_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(userId, limit) as unknown as UsageEventRow[];
}
