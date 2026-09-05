import { getDb, transaction } from "@/lib/db/client";
import { deleteExpiredPasswordResets } from "@/lib/db/repositories/password-resets";
import { cleanupExpiredSessions } from "@/lib/db/repositories/sessions";
import { deleteExpiredShares } from "@/lib/db/repositories/shares";
import {
  deleteFinishedJobsBefore,
  deleteStaleWorkers,
  expireJob,
  listStaleQueuedJobs,
} from "@/lib/db/repositories/jobs";
import { listExpiredPackages, listOrphanedPackages } from "@/lib/db/repositories/packages";
import { deleteOldReservations, releaseDanglingReservations, releaseReservationForResource } from "@/lib/db/repositories/quota";
import { finalizeTestRunWithoutResults, listStaleActiveTestRuns } from "@/lib/db/repositories/test-runs";
import { getRetentionConfig } from "@/lib/retention/config";
import { getRetentionForUser } from "@/lib/billing/entitlements";
import { listPlans } from "@/lib/billing/config";
import { deleteOldBillingEvents, deleteOldCheckouts, expireStaleCheckouts } from "@/lib/db/repositories/billing";
import { deleteExpiredAIResults } from "@/lib/db/repositories/ai";
import { logger } from "@/lib/observability/logger";
import type { ArtifactCleanupPayload } from "./types";

export interface CleanupReport {
  expiredArtifacts: number;
  expiredPackages: number;
  orphanedPackages: number;
  reconciledPackages: { missingBlobs: number; orphanedBlobs: number; pendingDeletions: number };
  expiredResetTokens: boolean;
  expiredSessions: boolean;
  expiredShares: boolean;
  staleJobsExpired: number;
  finishedJobsDeleted: number;
  staleRunsFinalized: number;
  reservationsReleased: number;
  staleCheckoutsExpired: number;
  billingEventsDeleted: number;
  aiResultsDeleted: number;
  /** Phase 9: stale/timed-out matrix runs finalized. */
  staleMatrixRunsFinalized: number;
  /** Phase 10: due webhook deliveries rescheduled (crash recovery). */
  webhookDeliveriesSwept: number;
  /** Phase 10: expired API idempotency records removed. */
  idempotencyRecordsDeleted: number;
  /** Phase 10: expired organization exports finalized + artifacts removed. */
  orgExportsExpired: number;
  /** Phase 10: audit events past each organization's retention removed. */
  orgAuditEventsDeleted: number;
}

/**
 * Scheduled cleanup. Every step is independent and idempotent; a failure in
 * one step is logged and the remaining steps still run. Only rows/blobs that
 * are past their retention window are touched — Phase 5 data is never deleted
 * before its retention elapses.
 */
export async function runCleanup(payload: ArtifactCleanupPayload = {}): Promise<CleanupReport> {
  const scope = payload.scope ?? "all";
  const retention = getRetentionConfig();
  const now = Date.now();
  const report: CleanupReport = {
    expiredArtifacts: 0,
    expiredPackages: 0,
    orphanedPackages: 0,
    reconciledPackages: { missingBlobs: 0, orphanedBlobs: 0, pendingDeletions: 0 },
    expiredResetTokens: false,
    expiredSessions: false,
    expiredShares: false,
    staleJobsExpired: 0,
    finishedJobsDeleted: 0,
    staleRunsFinalized: 0,
    reservationsReleased: 0,
    staleCheckoutsExpired: 0,
    billingEventsDeleted: 0,
    aiResultsDeleted: 0,
    staleMatrixRunsFinalized: 0,
    webhookDeliveriesSwept: 0,
    idempotencyRecordsDeleted: 0,
    orgExportsExpired: 0,
    orgAuditEventsDeleted: 0,
  };

  if (scope === "all" || scope === "artifacts") {
    await step("artifacts", async () => {
      const { deleteExpiredArtifacts } = await import("@/lib/artifacts/service");
      report.expiredArtifacts = await deleteExpiredArtifacts(now);
    });
  }

  if (scope === "all" || scope === "jobs") {
    await step("matrix-sweep", async () => {
      const { sweepStaleMatrixRuns } = await import("@/lib/testing/matrix-service");
      report.staleMatrixRunsFinalized = sweepStaleMatrixRuns(now);
    });
  }

  if (scope === "all" || scope === "packages") {
    await step("packages", async () => {
      const { finalizePackageDeletion, reconcilePackages } = await import("@/lib/packages/service");
      const { setPackageStatus } = await import("@/lib/db/repositories/packages");
      // Candidates are selected with the shortest retention of any plan, then
      // each row is checked against its owner's actual plan window.
      const shortestPackageRetentionMs = Math.min(
        retention.packageRetentionMs,
        ...listPlans().map((plan) => plan.packageRetentionDays * 24 * 60 * 60 * 1000),
      );
      const retentionCache = new Map<string, number>();
      const ownerRetention = (userId: string) => {
        let value = retentionCache.get(userId);
        if (value === undefined) {
          value = getRetentionForUser(userId).packageRetentionMs;
          retentionCache.set(userId, value);
        }
        return value;
      };
      for (const row of listOrphanedPackages(now - shortestPackageRetentionMs)) {
        if (row.created_at > now - ownerRetention(row.user_id)) continue;
        transaction(getDb(), () => setPackageStatus(row.id, "deleting"));
        await finalizePackageDeletion(row);
        report.orphanedPackages += 1;
      }
      for (const row of listExpiredPackages(now - shortestPackageRetentionMs)) {
        if ((row.last_used_at ?? row.created_at) > now - ownerRetention(row.user_id)) continue;
        transaction(getDb(), () => setPackageStatus(row.id, "deleting"));
        await finalizePackageDeletion(row);
        report.expiredPackages += 1;
      }
      report.reconciledPackages = await reconcilePackages();
    });
  }

  if (scope === "all" || scope === "auth") {
    await step("auth", async () => {
      deleteExpiredPasswordResets();
      report.expiredResetTokens = true;
      cleanupExpiredSessions();
      report.expiredSessions = true;
      deleteExpiredShares();
      report.expiredShares = true;
    });
  }

  if (scope === "all" || scope === "jobs") {
    await step("jobs", async () => {
      for (const job of listStaleQueuedJobs(now - retention.staleQueuedJobMs)) {
        if (expireJob(job.id)) report.staleJobsExpired += 1;
      }
      report.finishedJobsDeleted = deleteFinishedJobsBefore(now - retention.jobRetentionMs);
      for (const run of listStaleActiveTestRuns(now - retention.staleRunMs)) {
        finalizeTestRunWithoutResults({
          id: run.id,
          status: "failed",
          outcome: "INFRASTRUCTURE_ERROR",
          errorCode: "WORKER_UNAVAILABLE",
          reason: "The run stopped receiving updates and was closed by maintenance.",
        });
        releaseReservationForResource(run.id);
        report.staleRunsFinalized += 1;
      }
      report.reservationsReleased = releaseDanglingReservations(now - 60 * 60 * 1000);
      deleteOldReservations(now - retention.jobRetentionMs);
      deleteStaleWorkers(now - 24 * 60 * 60 * 1000);
    });
  }

  if (scope === "all" || scope === "billing") {
    await step("billing", async () => {
      // Checkout sessions expire on the provider after ~24h; mirror that locally.
      report.staleCheckoutsExpired = expireStaleCheckouts(now - 24 * 60 * 60 * 1000);
      deleteOldCheckouts(now - retention.jobRetentionMs);
      // The event ledger only needs to outlive the provider's retry horizon
      // (days); keep 90 days for audit/troubleshooting.
      report.billingEventsDeleted = deleteOldBillingEvents(now - 90 * 24 * 60 * 60 * 1000);
    });
  }

  if (scope === "all" || scope === "organizations") {
    await step("webhook-deliveries", async () => {
      const { sweepDueWebhookDeliveries } = await import("@/lib/webhooks/deliver");
      report.webhookDeliveriesSwept = await sweepDueWebhookDeliveries(50);
    });
    await step("idempotency", async () => {
      const { deleteExpiredIdempotencyRecords } = await import("@/lib/idempotency/service");
      report.idempotencyRecordsDeleted = deleteExpiredIdempotencyRecords(now);
    });
    await step("org-exports", async () => {
      const { expireExports } = await import("@/lib/organizations/export");
      report.orgExportsExpired = await expireExports(now);
    });
    await step("org-audit-retention", async () => {
      const { getConfig } = await import("@/lib/config/env");
      const { listOrganizationsForRetentionSweep, deleteAuditEventsBefore } = await import("@/lib/organizations/repository");
      const { getOrganizationEntitlements } = await import("@/lib/organizations/entitlements");
      const baseDays = getConfig().organizations.auditRetentionDays;
      for (const org of listOrganizationsForRetentionSweep()) {
        const entitlements = getOrganizationEntitlements(org.id);
        const days = Math.max(baseDays, entitlements.extendedArtifactRetentionDays ?? 0);
        report.orgAuditEventsDeleted += deleteAuditEventsBefore(org.id, now - days * 24 * 60 * 60 * 1000);
      }
    });
  }

  if (scope === "all" || scope === "ai") {
    await step("ai", async () => {
      // Stored AI results expire after AI_RESULT_RETENTION_DAYS (set per row when written).
      report.aiResultsDeleted = deleteExpiredAIResults(now);
    });
  }

  logger.info("cleanup.completed", { ...flatten(report) });
  return report;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error("cleanup.step_failed", { step: name, errorCode: "INTERNAL", detail: error instanceof Error ? error.name : "unknown" });
  }
}

function flatten(report: CleanupReport): Record<string, unknown> {
  return {
    expiredArtifacts: report.expiredArtifacts,
    expiredPackages: report.expiredPackages,
    orphanedPackages: report.orphanedPackages,
    missingBlobs: report.reconciledPackages.missingBlobs,
    orphanedBlobs: report.reconciledPackages.orphanedBlobs,
    staleJobsExpired: report.staleJobsExpired,
    finishedJobsDeleted: report.finishedJobsDeleted,
    staleRunsFinalized: report.staleRunsFinalized,
    reservationsReleased: report.reservationsReleased,
    aiResultsDeleted: report.aiResultsDeleted,
  };
}
