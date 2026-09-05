import "server-only";
import { getDb, transaction } from "@/lib/db/client";
import {
  createArtifactRecord,
  deleteArtifactRecord,
  getOwnedArtifact,
  listArtifactsForRun,
  listExpiredArtifacts,
  toArtifactSummary,
  type ArtifactSummary,
  type ArtifactType,
} from "@/lib/db/repositories/artifacts";
import { getStorage } from "@/lib/storage/storage";
import { artifactStorageKey, sha256Hex } from "@/lib/storage/validation";
import { StorageError } from "@/lib/storage/types";
import { getRetentionConfig } from "@/lib/retention/config";
import { testConfig } from "@/lib/testing/config";
import { redactSensitiveText, redactUrlShallow } from "@/lib/runtime/redact";
import { logger } from "@/lib/observability/logger";
import type { ArtifactRow } from "@/lib/db/schema/types";
import type { CapturedScreenshot, NetworkEntryLike, RuntimeEventLike } from "@/lib/testing/types";

const CONTENT_TYPES: Record<ArtifactType, string> = {
  screenshot: "image/png",
  "runtime-log": "application/json",
  "network-summary": "application/json",
};

/**
 * Persists evidence produced by a run. Each artifact is written to storage
 * first, verified, then registered; a failed registration removes the blob.
 * Artifacts are bounded in count and size by TEST_ENGINE_CONFIG.
 */
export async function persistRunArtifacts(input: {
  runId: string;
  userId: string;
  screenshots: CapturedScreenshot[];
  runtimeEvents: RuntimeEventLike[];
  network: NetworkEntryLike[];
}): Promise<ArtifactSummary[]> {
  const created: ArtifactSummary[] = [];
  const expiresAt = Date.now() + getRetentionConfig().artifactRetentionMs;
  const config = testConfig();

  for (const shot of input.screenshots.slice(0, config.MAX_SCREENSHOTS)) {
    if (shot.bytes.byteLength === 0 || shot.bytes.byteLength > config.MAX_ARTIFACT_SIZE) continue;
    const summary = await writeArtifact({
      runId: input.runId,
      userId: input.userId,
      type: "screenshot",
      bytes: shot.bytes,
      extension: "png",
      label: `Screenshot for ${shot.testId}`,
      expiresAt,
    });
    if (summary) created.push(summary);
  }

  if (input.runtimeEvents.length > 0) {
    const log = input.runtimeEvents.slice(-config.MAX_EVENTS).map((event) => ({
      timestamp: event.timestamp,
      type: event.type,
      level: event.level,
      source: event.source,
      message: redactSensitiveText(event.message).slice(0, 2000),
    }));
    const summary = await writeArtifact({
      runId: input.runId,
      userId: input.userId,
      type: "runtime-log",
      bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, runId: input.runId, events: log })),
      extension: "json",
      label: "Runtime console log",
      expiresAt,
    });
    if (summary) created.push(summary);
  }

  if (input.network.length > 0) {
    const entries = input.network.slice(-config.MAX_NETWORK_EVENTS).map((entry) => ({
      timestamp: entry.timestamp,
      method: entry.method,
      url: redactUrlShallow(entry.url),
      status: entry.status,
      resourceType: entry.resourceType,
      duration: entry.duration,
    }));
    const summary = await writeArtifact({
      runId: input.runId,
      userId: input.userId,
      type: "network-summary",
      bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, runId: input.runId, requests: entries })),
      extension: "json",
      label: "Network summary",
      expiresAt,
    });
    if (summary) created.push(summary);
  }

  return created;
}

async function writeArtifact(input: {
  runId: string;
  userId: string;
  type: ArtifactType;
  bytes: Uint8Array;
  extension: string;
  label: string;
  expiresAt: number;
}): Promise<ArtifactSummary | null> {
  const storage = getStorage();
  const key = artifactStorageKey(input.runId, input.extension);
  const sha256 = sha256Hex(input.bytes);
  try {
    await storage.put(key, input.bytes, { contentType: CONTENT_TYPES[input.type] });
    const stat = await storage.stat(key);
    if (!stat || stat.size !== input.bytes.byteLength) throw new StorageError("io", "Artifact verification failed.");
  } catch {
    await storage.delete(key).catch(() => undefined);
    logger.warn("artifact.store_failed", { runId: input.runId, artifactType: input.type, errorCode: "STORAGE_ERROR" });
    return null;
  }
  try {
    const row = transaction(getDb(), () =>
      createArtifactRecord({
        testRunId: input.runId,
        userId: input.userId,
        type: input.type,
        storageKey: key,
        size: input.bytes.byteLength,
        sha256,
        contentType: CONTENT_TYPES[input.type],
        label: input.label,
        expiresAt: input.expiresAt,
      }),
    );
    return toArtifactSummary(row);
  } catch {
    await storage.delete(key).catch(() => undefined);
    logger.warn("artifact.persist_failed", { runId: input.runId, artifactType: input.type, errorCode: "STORAGE_ERROR" });
    return null;
  }
}

export function listOwnedRunArtifacts(userId: string, runId: string): ArtifactSummary[] {
  return listArtifactsForRun(runId)
    .filter((row) => row.user_id === userId && row.expires_at > Date.now())
    .map(toArtifactSummary);
}

/** Streams an artifact to its owner. Ownership is enforced through the row itself. */
export async function readOwnedArtifact(userId: string, artifactId: string): Promise<{ row: ArtifactRow; bytes: Uint8Array } | null> {
  const row = getOwnedArtifact(userId, artifactId);
  if (!row || row.expires_at <= Date.now()) return null;
  try {
    const bytes = await getStorage().get(row.storage_key);
    if (sha256Hex(bytes) !== row.sha256) {
      logger.error("artifact.integrity_mismatch", { artifactId: row.id, errorCode: "STORAGE_ERROR" });
      return null;
    }
    return { row, bytes };
  } catch (error) {
    if (error instanceof StorageError && error.kind === "not_found") return null;
    throw error;
  }
}

export async function deleteArtifact(row: ArtifactRow): Promise<boolean> {
  try {
    await getStorage().delete(row.storage_key);
  } catch {
    logger.warn("artifact.blob_delete_failed", { artifactId: row.id, errorCode: "STORAGE_ERROR" });
    return false;
  }
  transaction(getDb(), () => deleteArtifactRecord(row.id));
  return true;
}

export async function deleteExpiredArtifacts(now = Date.now()): Promise<number> {
  let deleted = 0;
  for (const row of listExpiredArtifacts(now)) {
    if (await deleteArtifact(row)) deleted += 1;
  }
  return deleted;
}
