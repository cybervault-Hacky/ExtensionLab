import "server-only";
import { createHash } from "node:crypto";
import { getDb, transaction } from "@/lib/db/client";
import { generateDbId } from "@/lib/db/ids";
import { AppError } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";
import type { ApiIdempotencyRecordRow } from "@/lib/db/schema/types";

/**
 * Idempotency for expensive public API operations (Phase 10).
 *
 * Repeating a request with the same `Idempotency-Key` replays the stored
 * original response instead of creating a second package/run/matrix. Records
 * are scoped to their owner (user or organization), so identical keys can
 * never collide across tenants. A key reused with a *different* request body
 * is a hard conflict (409), never a silent replay.
 */

export interface IdempotencyOwner {
  type: "user" | "organization";
  id: string;
}

export interface StoredResponse {
  status: number;
  body: Record<string, unknown>;
}

const IN_FLIGHT_TIMEOUT_MS = 5 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function hashRequestPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function getRecord(owner: IdempotencyOwner, key: string): ApiIdempotencyRecordRow | null {
  const row = getDb()
    .prepare("SELECT * FROM api_idempotency_records WHERE owner_type = ? AND owner_id = ? AND idempotency_key = ?")
    .get(owner.type, owner.id, key);
  return (row as unknown as ApiIdempotencyRecordRow | undefined) ?? null;
}

export interface IdempotencyOutcome {
  /** `replay` — return the stored response instead of executing. */
  replay: boolean;
  stored?: StoredResponse;
  /** Handle to commit or roll back after the operation runs. */
  commit: (response: StoredResponse) => void;
  rollback: () => void;
}

/**
 * Wraps an expensive operation with idempotency. The record is created
 * transactionally before execution; a crash mid-flight leaves an `in_flight`
 * row that expires and is swept (the client may retry with the same key).
 */
export async function withIdempotency(
  owner: IdempotencyOwner,
  key: string | null,
  endpoint: string,
  requestFingerprint: string,
  operation: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  if (!key || key.trim() === "") return operation();
  const normalized = key.trim().slice(0, 180);
  const requestHash = hashRequestPayload(requestFingerprint);
  const now = Date.now();

  const existing = getRecord(owner, normalized);
  if (existing) {
    if (existing.expires_at < now) {
      // Expired record: safe to replace (same key may start a fresh operation).
      transaction(getDb(), () => {
        getDb().prepare("DELETE FROM api_idempotency_records WHERE id = ?").run(existing.id);
      });
    } else {
      if (existing.request_hash !== requestHash) {
        throw new AppError("IDEMPOTENCY_CONFLICT");
      }
      if (existing.status === "completed" && existing.response_json) {
        return {
          status: existing.response_status ?? 200,
          body: JSON.parse(existing.response_json) as Record<string, unknown>,
        };
      }
      if (existing.status === "in_flight" && existing.created_at > now - IN_FLIGHT_TIMEOUT_MS) {
        // Another request with the same key is still executing.
        throw new AppError("CONFLICT", { message: "A request with this idempotency key is still in progress." });
      }
      transaction(getDb(), () => {
        getDb().prepare("DELETE FROM api_idempotency_records WHERE id = ?").run(existing.id);
      });
    }
  }

  const recordId = generateDbId("idem");
  transaction(getDb(), () => {
    getDb()
      .prepare(
        `INSERT INTO api_idempotency_records (id, owner_type, owner_id, idempotency_key, endpoint, request_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'in_flight', ?, ?)`,
      )
      .run(recordId, owner.type, owner.id, normalized, endpoint.slice(0, 120), requestHash, now, now + RETENTION_MS);
  });

  try {
    const response = await operation();
    transaction(getDb(), () => {
      getDb()
        .prepare("UPDATE api_idempotency_records SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE id = ?")
        .run(response.status, JSON.stringify(response.body), Date.now(), recordId);
    });
    return response;
  } catch (error) {
    // Failed operations release the key so the client can retry honestly.
    transaction(getDb(), () => {
      getDb().prepare("DELETE FROM api_idempotency_records WHERE id = ?").run(recordId);
    });
    throw error;
  }
}

/** Retention sweep (idempotent, called by the cleanup job). */
export function deleteExpiredIdempotencyRecords(now = Date.now()): number {
  const result = getDb().prepare("DELETE FROM api_idempotency_records WHERE expires_at < ?").run(now);
  logger.debug("idempotency.swept", { removed: Number(result.changes) });
  return Number(result.changes);
}
