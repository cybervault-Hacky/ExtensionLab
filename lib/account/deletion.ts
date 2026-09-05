import "server-only";
import { getConfig } from "@/lib/config/env";
import { getDb, transaction } from "@/lib/db/client";
import { deleteUser } from "@/lib/db/repositories/users";
import { listActiveTestRunsForUser } from "@/lib/db/repositories/test-runs";
import { listOpenSubscriptionsForUser } from "@/lib/db/repositories/billing";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import { cancelJob } from "@/lib/jobs/queue";
import { getStorage } from "@/lib/storage/storage";
import { logger, recordMetric } from "@/lib/observability/logger";
import { AppError } from "@/lib/observability/errors";
import { getBillingProvider, isBillingEnabled } from "@/lib/billing/provider";

/**
 * Deletes an account and everything it owns.
 *
 * Order matters:
 *  1. Subscriptions are cancelled on the payment provider *first* (policy
 *     `BILLING_DELETION_POLICY`: immediately by default, or at period end).
 *     If the provider cannot be reached the deletion is refused with a
 *     retryable error rather than leaving a paying subscription behind for
 *     an account that no longer exists.
 *  2. Work in flight is cancelled so the worker does not write into deleted rows.
 *  3. Database rows are removed in one transaction (cascades cover sessions,
 *     extensions, snapshots, test runs, reports, shares, jobs, reservations,
 *     packages, artifacts, billing customers, subscriptions and checkouts;
 *     the billing event ledger keeps its rows with user_id set to NULL).
 *  4. Blobs are removed afterwards, best-effort; storage reconciliation
 *     removes any blob that no longer has a metadata row.
 */
export async function deleteAccount(userId: string): Promise<{ blobsDeleted: number; blobsFailed: number; subscriptionsCancelled: number }> {
  const subscriptionsCancelled = await cancelSubscriptionsForDeletion(userId);

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
  logger.info("account.deleted", { userId, blobsDeleted, blobsFailed, subscriptionsCancelled });
  return { blobsDeleted, blobsFailed, subscriptionsCancelled };
}

async function cancelSubscriptionsForDeletion(userId: string): Promise<number> {
  const open = listOpenSubscriptionsForUser(userId);
  if (open.length === 0) return 0;
  if (!isBillingEnabled()) {
    // Local rows exist but no provider is configured (e.g. provider switched
    // off after subscriptions were sold). Nothing can be charged without a
    // provider, so deletion proceeds; the operator runbook covers reconciliation.
    logger.warn("account.delete_subscriptions_unmanaged", { userId, count: open.length });
    return 0;
  }
  const provider = getBillingProvider();
  const policy = getConfig().billing.deletionPolicy;
  let cancelled = 0;
  for (const row of open) {
    if (row.provider !== provider.name) {
      logger.warn("account.delete_subscription_other_provider", { userId, subscriptionId: row.id, provider: row.provider });
      continue;
    }
    try {
      const remote = await provider.getSubscription(row.provider_subscription_id);
      if (!remote || remote.status === "canceled") {
        cancelled += 1;
        continue;
      }
      if (policy === "cancel_at_period_end" && !remote.cancelAtPeriodEnd && provider.capabilities.cancelAtPeriodEnd) {
        await provider.cancelSubscription(row.provider_subscription_id, { atPeriodEnd: true });
      } else if (policy === "cancel_immediately") {
        await provider.cancelSubscription(row.provider_subscription_id, { atPeriodEnd: false });
      }
      cancelled += 1;
      recordAuditEvent({ userId, type: "subscription_cancelled", detail: `Account deletion (${policy.replace(/_/g, " ")})` });
      recordMetric("billing.cancellation", 1, { provider: provider.name, plan: row.plan_id, reason: "account_deleted" });
    } catch (error) {
      logger.error("account.delete_subscription_failed", {
        userId,
        subscriptionId: row.id,
        errorCode: error instanceof AppError ? error.code : "BILLING_PROVIDER_ERROR",
      });
      throw new AppError("BILLING_PROVIDER_ERROR", {
        retryable: true,
        message: "Your subscription could not be cancelled right now, so the account was not deleted. Please try again in a few minutes.",
        cause: error,
      });
    }
  }
  return cancelled;
}
