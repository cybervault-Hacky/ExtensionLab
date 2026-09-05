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
  };

  if (scope === "all" || scope === "artifacts") {
    await step("artifacts", async () => {
      const { deleteExpiredArtifacts } = await import("@/lib/artifacts/service");
      report.expiredArtifacts = await deleteExpiredArtifacts(now);
    });
  }

  if (scope === "all" || scope === "packages") {
    await step("packages", async () => {
      const { finalizePackageDeletion, reconcilePackages } = await import("@/lib/packages/service");
      const { setPackageStatus } = await import("@/lib/db/repositories/packages");
      for (const row of listOrphanedPackages(now - retention.packageRetentionMs)) {
        transaction(getDb(), () => setPackageStatus(row.id, "deleting"));
        await finalizePackageDeletion(row);
        report.orphanedPackages += 1;
      }
      for (const row of listExpiredPackages(now - retention.packageRetentionMs)) {
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
  };
}
