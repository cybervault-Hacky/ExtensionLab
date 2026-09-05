import "server-only";
import { getDb, transaction } from "@/lib/db/client";
import { deleteUser } from "@/lib/db/repositories/users";
import { listActiveTestRunsForUser } from "@/lib/db/repositories/test-runs";
import { cancelJob } from "@/lib/jobs/queue";
import { getStorage } from "@/lib/storage/storage";
import { logger } from "@/lib/observability/logger";

/**
 * Deletes an account and everything it owns.
 *
 * Database rows are removed in one transaction (cascades cover sessions,
 * extensions, snapshots, test runs, reports, shares, jobs, reservations,
 * packages and artifacts). Blobs are removed afterwards, best-effort: a
 * failure there can never leave the account half-deleted, and the storage
 * reconciliation job removes any blob that no longer has a metadata row.
 */
export async function deleteAccount(userId: string): Promise<{ blobsDeleted: number; blobsFailed: number }> {
  // Stop work in flight first so the worker does not write into deleted rows.
  for (const run of listActiveTestRunsForUser(userId)) {
    if (run.job_id) cancelJob(run.job_id);
  }

  const keys = transaction(getDb(), () => {
    const db = getDb();
    const packageKeys = db.prepare("SELECT storage_key FROM extension_packages WHERE user_id = ?").all(userId) as Array<{ storage_key: string }>;
    const artifactKeys = db.prepare("SELECT storage_key FROM artifacts WHERE user_id = ?").all(userId) as Array<{ storage_key: string }>;
    deleteUser(userId);
    return [...packageKeys, ...artifactKeys].map((row) => row.storage_key);
  });

  let blobsDeleted = 0;
  let blobsFailed = 0;
  const storage = getStorage();
  for (const key of keys) {
    try {
      await storage.delete(key);
      blobsDeleted += 1;
    } catch {
      blobsFailed += 1;
    }
  }
  logger.info("account.deleted", { userId, blobsDeleted, blobsFailed });
  return { blobsDeleted, blobsFailed };
}
