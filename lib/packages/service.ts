import "server-only";
import { getDb, transaction } from "@/lib/db/client";
import {
  createPackageRecord,
  deletePackageRecord,
  findStoredPackageByHash,
  getOwnedPackage,
  getPackageById,
  listAllPackageKeys,
  listPackagesMarkedDeleting,
  setPackageStatus,
  touchPackage,
  toPackage,
  type ExtensionPackage,
} from "@/lib/db/repositories/packages";
import { listTestRunsForPackage } from "@/lib/db/repositories/test-runs";
import { getStorage } from "@/lib/storage/storage";
import { packageStorageKey, sha256Hex } from "@/lib/storage/validation";
import { StorageError } from "@/lib/storage/types";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { ExtensionLabError } from "@/lib/extension/errors";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { canUploadPackage } from "@/lib/billing/entitlements";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import type { ExtensionAnalysis } from "@/types/extension";
import type { ExtensionPackageRow } from "@/lib/db/schema/types";

export interface StoredPackageResult {
  package: ExtensionPackage;
  analysis: ExtensionAnalysis;
  reused: boolean;
}

/**
 * Validates, stores and registers an uploaded extension package.
 *
 * Order matters: the ZIP is fully validated by the Phase 1 analyzer (size,
 * file count, zip-bomb guards, manifest) *before* anything touches storage.
 * After the write, the object is read back and its hash verified; only then
 * is the metadata row committed. Any failure after the write deletes the
 * stored object so storage can never hold an unreferenced blob.
 */
export async function storeExtensionPackage(input: {
  userId: string;
  bytes: Uint8Array;
  fileName: string;
  extensionId?: string | null;
}): Promise<StoredPackageResult> {
  if (input.bytes.byteLength === 0) {
    throw new AppError("INVALID_EXTENSION", { message: "The uploaded file is empty." });
  }
  if (input.bytes.byteLength > MAX_EXTENSION_SIZE) {
    throw new AppError("INVALID_EXTENSION", { message: "This file is larger than the 25 MB limit." });
  }
  const sizeEntitlement = canUploadPackage(input.userId, input.bytes.byteLength);
  if (!sizeEntitlement.allowed) {
    const mb = sizeEntitlement.reason === "size" ? Math.floor(sizeEntitlement.maxExtensionSize / (1024 * 1024)) : 0;
    throw new AppError("PAYMENT_REQUIRED", { message: `This extension is larger than your plan's ${mb} MB limit.` });
  }

  let analysis: ExtensionAnalysis;
  try {
    analysis = await analyzeZipBytes(input.bytes, input.fileName);
  } catch (error) {
    if (error instanceof ExtensionLabError) {
      throw new AppError("INVALID_EXTENSION", { message: error.message, cause: error });
    }
    throw new AppError("INVALID_EXTENSION", { cause: error });
  }
  const sha256 = sha256Hex(input.bytes);
  const existing = findStoredPackageByHash(input.userId, sha256);
  if (existing && (await getStorage().exists(existing.storage_key))) {
    touchPackage(existing.id);
    return { package: toPackage(existing), analysis, reused: true };
  }

  const storage = getStorage();
  const key = packageStorageKey(input.userId);
  const startedAt = Date.now();
  try {
    await storage.put(key, input.bytes, { contentType: "application/zip" });
    const stored = await storage.get(key);
    if (stored.byteLength !== input.bytes.byteLength || sha256Hex(stored) !== sha256) {
      throw new StorageError("io", "Stored package verification failed.");
    }
  } catch (error) {
    await storage.delete(key).catch(() => undefined);
    logger.error("package.store_failed", { userId: input.userId, errorCode: "STORAGE_ERROR" });
    throw new AppError("STORAGE_ERROR", { cause: error });
  }

  let row: ExtensionPackageRow;
  try {
    row = transaction(getDb(), () =>
      createPackageRecord({
        userId: input.userId,
        extensionId: input.extensionId ?? null,
        storageKey: key,
        sha256,
        size: input.bytes.byteLength,
        version: analysis.manifest.version ?? null,
        originalName: input.fileName.slice(0, 200),
      }),
    );
  } catch (error) {
    // Database failure after a successful write: remove the blob so nothing dangles.
    await storage.delete(key).catch(() => undefined);
    logger.error("package.persist_failed", { userId: input.userId, errorCode: "STORAGE_ERROR" });
    throw new AppError("STORAGE_ERROR", { cause: error });
  }

  recordMetric("package.stored", 1, { reused: "false" });
  logger.info("package.stored", {
    userId: input.userId,
    packageId: row.id,
    size: row.size,
    durationMs: Date.now() - startedAt,
    result: "ok",
  });
  return { package: toPackage(row), analysis, reused: false };
}

/** Reads a stored package for the owner; verifies integrity before returning bytes. */
export async function readOwnedPackageBytes(userId: string, packageId: string): Promise<{ row: ExtensionPackageRow; bytes: Uint8Array }> {
  const row = getOwnedPackage(userId, packageId);
  if (!row) throw new AppError("NOT_FOUND", { message: "Package not found." });
  return { row, bytes: await readVerifiedPackage(row) };
}

/** Worker-side read (ownership is enforced by the job that references the package). */
export async function readPackageBytes(packageId: string): Promise<{ row: ExtensionPackageRow; bytes: Uint8Array }> {
  const row = getPackageById(packageId);
  if (!row || row.status !== "stored") throw new AppError("NOT_FOUND", { message: "Package not found." });
  return { row, bytes: await readVerifiedPackage(row) };
}

async function readVerifiedPackage(row: ExtensionPackageRow): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await getStorage().get(row.storage_key);
  } catch (error) {
    if (error instanceof StorageError && error.kind === "not_found") {
      throw new AppError("STORAGE_ERROR", { message: "The stored package is no longer available.", retryable: false, cause: error });
    }
    throw new AppError("STORAGE_ERROR", { cause: error });
  }
  if (sha256Hex(bytes) !== row.sha256) {
    logger.error("package.integrity_mismatch", { packageId: row.id, errorCode: "STORAGE_ERROR" });
    throw new AppError("STORAGE_ERROR", { message: "The stored package failed an integrity check.", retryable: false });
  }
  return bytes;
}

/**
 * Deletes a package: blocks while an active run references it, marks the row
 * as deleting inside a transaction, removes the blob, then removes the row.
 * If blob deletion fails the row stays in `deleting` and the reconciliation
 * job retries later.
 */
export async function deleteOwnedPackage(userId: string, packageId: string): Promise<boolean> {
  const row = getOwnedPackage(userId, packageId);
  if (!row) return false;
  const active = listTestRunsForPackage(row.id).some((run) =>
    ["idle", "queued", "preparing", "starting", "running", "stopping"].includes(run.status),
  );
  if (active) throw new AppError("CONFLICT", { message: "This package is used by an active test run." });
  transaction(getDb(), () => setPackageStatus(row.id, "deleting"));
  await finalizePackageDeletion(row);
  return true;
}

export async function finalizePackageDeletion(row: ExtensionPackageRow): Promise<void> {
  try {
    await getStorage().delete(row.storage_key);
  } catch {
    logger.warn("package.blob_delete_failed", { packageId: row.id, errorCode: "STORAGE_ERROR" });
    return;
  }
  transaction(getDb(), () => deletePackageRecord(row.id));
  logger.info("package.deleted", { packageId: row.id, result: "ok" });
}

export interface ReconciliationReport {
  missingBlobs: number;
  orphanedBlobs: number;
  pendingDeletions: number;
}

/**
 * Reconciles storage with metadata: rows whose blob is missing are marked
 * `deleted`; blobs with no row are removed; rows stuck in `deleting` are
 * finalized. Runs from the scheduled cleanup job.
 */
export async function reconcilePackages(): Promise<ReconciliationReport> {
  const storage = getStorage();
  const rows = listAllPackageKeys();
  const known = new Set(rows.map((row) => row.storage_key));
  let missingBlobs = 0;
  for (const row of rows) {
    if (row.status !== "stored") continue;
    if (!(await storage.exists(row.storage_key))) {
      missingBlobs += 1;
      transaction(getDb(), () => setPackageStatus(row.id, "deleted"));
      logger.warn("package.blob_missing", { packageId: row.id });
    }
  }
  let orphanedBlobs = 0;
  for (const key of await storage.list("extensions")) {
    if (known.has(key)) continue;
    const info = await storage.stat(key);
    // Give in-flight uploads a grace period before treating the blob as orphaned.
    if (info && Date.now() - info.createdAt < 10 * 60 * 1000) continue;
    await storage.delete(key).catch(() => undefined);
    orphanedBlobs += 1;
  }
  let pendingDeletions = 0;
  for (const row of listPackagesMarkedDeleting()) {
    pendingDeletions += 1;
    await finalizePackageDeletion(row);
  }
  if (missingBlobs || orphanedBlobs || pendingDeletions) {
    logger.info("package.reconciled", { missingBlobs, orphanedBlobs, pendingDeletions });
  }
  return { missingBlobs, orphanedBlobs, pendingDeletions };
}
