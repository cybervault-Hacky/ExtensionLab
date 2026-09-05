import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { AIResultRow } from "../schema/types";

/**
 * Persistence for validated AI results (Phase 8).
 *
 * Only the schema-validated response is stored, together with provider/model
 * metadata and token counts. Prompts, raw provider payloads and the sanitized
 * context are never written. Rows are owner-scoped, cascade with the user and
 * expire after the configured retention window.
 */

export interface AIResultLookup {
  userId: string;
  feature: string;
  resourceKind: string;
  resourceId: string;
  targetId: string | null;
  contextHash: string;
}

export function findAIResult(lookup: AIResultLookup, now = Date.now()): AIResultRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM ai_results
         WHERE user_id = ? AND feature = ? AND resource_kind = ? AND resource_id = ?
           AND target_id IS ? AND context_hash = ? AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(lookup.userId, lookup.feature, lookup.resourceKind, lookup.resourceId, lookup.targetId, lookup.contextHash, now) as
      | AIResultRow
      | undefined) ?? null
  );
}

export function insertAIResult(input: AIResultLookup & {
  provider: string;
  model: string;
  resultJson: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  expiresAt: number;
}): AIResultRow {
  const db = getDb();
  const id = generateDbId("air");
  db.prepare(
    `INSERT INTO ai_results
      (id, user_id, feature, resource_kind, resource_id, target_id, provider, model, context_hash,
       result_json, input_tokens, output_tokens, duration_ms, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.feature,
    input.resourceKind,
    input.resourceId,
    input.targetId,
    input.provider,
    input.model,
    input.contextHash,
    input.resultJson,
    input.inputTokens,
    input.outputTokens,
    input.durationMs,
    Date.now(),
    input.expiresAt,
  );
  return db.prepare("SELECT * FROM ai_results WHERE id = ?").get(id) as unknown as AIResultRow;
}

export function deleteExpiredAIResults(now = Date.now()): number {
  return Number(getDb().prepare("DELETE FROM ai_results WHERE expires_at <= ?").run(now).changes);
}

export function deleteAIResultsForUser(userId: string): number {
  return Number(getDb().prepare("DELETE FROM ai_results WHERE user_id = ?").run(userId).changes);
}

export function countAIResultsForUser(userId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS total FROM ai_results WHERE user_id = ?").get(userId) as { total: number }).total;
}
