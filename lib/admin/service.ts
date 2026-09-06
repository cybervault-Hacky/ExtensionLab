import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config/env";
import {
  countJobsByStatus,
  getJobById,
  isTerminalJobStatus,
  markCancelled,
  requestCancel,
  requeueFailedJob,
  summarizeLiveWorkers,
} from "@/lib/db/repositories/jobs";
import {
  countSessionsByStatus,
  listAdmittedSessions,
  listRecentlyFinishedSessions,
} from "@/lib/db/repositories/browser-sessions";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import {
  listWorkerStatuses,
  setWorkerDesiredStateByRef,
  type WorkerDesiredState,
} from "@/lib/jobs/worker-registry";
import { AppError } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";

/**
 * Internal admin abstraction (Phase 10).
 *
 * Deliberately narrow: queue depth, live worker health, and retry/cancel for
 * jobs. It provides NO shell, NO file access and NO Docker execution — an
 * operator cannot execute anything through this surface, only influence the
 * job queue. Fail closed: with ADMIN_API_ENABLED unset/false the surface is
 * indistinguishable from a missing route (404) and the token check is
 * constant-time.
 */

export function requireAdmin(request: NextRequest): void {
  const config = getConfig();
  if (!config.adminApi.enabled || !config.adminApi.tokenHash) {
    throw new AppError("NOT_FOUND", { message: "Not found." });
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S{1,512})$/i.exec(header);
  const provided = Buffer.from(createHash("sha256").update(match?.[1] ?? "\0").digest("hex"), "utf8");
  const expected = Buffer.from(config.adminApi.tokenHash, "utf8");
  if (!match || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AppError("AUTH_REQUIRED", { message: "Invalid admin credentials." });
  }
}

export interface AdminOverview {
  queue: Record<string, number>;
  workers: {
    live: number;
    totalConcurrency: number;
    activeJobs: number;
    sandboxAvailable: boolean | null;
    lastSeenAt: number | null;
  };
  /** Phase 11: interactive browser session counts by status. */
  interactiveSessions: Record<string, number>;
}

export function getAdminOverview(): AdminOverview {
  const summary = summarizeLiveWorkers(60_000);
  return {
    queue: countJobsByStatus(),
    workers: {
      live: summary.count,
      totalConcurrency: summary.totalConcurrency,
      activeJobs: summary.activeJobs,
      sandboxAvailable: summary.sandboxAvailable,
      lastSeenAt: summary.lastSeenAt,
    },
    interactiveSessions: countSessionsByStatus(),
  };
}

/**
 * Phase 11: operator view of interactive sessions. Read-only, safe
 * projections only — no runtime coordinates, container ids or tokens.
 */
export function listInteractiveSessionsAdmin(): Array<Record<string, unknown>> {
  return listAdmittedSessions()
    .concat(listRecentlyFinishedSessions(25))
    .slice(0, 100)
    .map((row) => ({
      id: row.id,
      userId: row.user_id,
      organizationId: row.organization_id,
      packageId: row.package_id,
      packageVersion: row.package_version,
      browser: row.browser,
      browserVersion: row.browser_version,
      status: row.status,
      stateReason: row.state_reason,
      stopReason: row.stop_reason,
      createdAt: row.created_at,
      readyAt: row.ready_at,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.expires_at,
      stoppedAt: row.stopped_at,
    }));
}

export function retryJobAdmin(requestId: string | null, jobId: string): { id: string; status: string } {
  const job = getJobById(jobId);
  if (!job) throw new AppError("NOT_FOUND");
  if (job.status !== "failed") {
    throw new AppError("INVALID_INPUT", { message: "Only failed jobs can be retried." });
  }
  if (!requeueFailedJob(jobId)) {
    throw new AppError("CONFLICT", { message: "The job could not be requeued." });
  }
  recordAuditEvent({ userId: null, type: "admin_job_retry", detail: jobId });
  logger.warn("admin.job_retry", { requestId: requestId ?? undefined, jobId });
  return { id: jobId, status: getJobById(jobId)?.status ?? "unknown" };
}

export function cancelJobAdmin(requestId: string | null, jobId: string): { id: string; status: string } {
  const job = getJobById(jobId);
  if (!job) throw new AppError("NOT_FOUND");
  if (isTerminalJobStatus(job.status)) {
    throw new AppError("CONFLICT", { message: "The job already reached a terminal state." });
  }
  // Queued/retrying jobs stop immediately; running jobs stop cooperatively at
  // their next checkpoint (the worker observes the cancel request).
  if (job.status === "running") {
    if (!requestCancel(jobId).changed) {
      throw new AppError("CONFLICT", { message: "Cancellation could not be requested." });
    }
  } else if (!markCancelled(jobId)) {
    throw new AppError("CONFLICT", { message: "The job could not be cancelled." });
  }
  recordAuditEvent({ userId: null, type: "admin_job_cancel", detail: jobId });
  logger.warn("admin.job_cancel", { requestId: requestId ?? undefined, jobId });
  return { id: jobId, status: getJobById(jobId)?.status ?? "unknown" };
}

/* ------------------------------------------------------------------------ */
/* Phase 13: worker lifecycle admin (§55–§57)                                */
/* ------------------------------------------------------------------------ */

export function listWorkersAdmin() {
  return listWorkerStatuses();
}

/**
 * High-level worker control ONLY: drain (stop claiming, finish active),
 * disable, re-enable. No shell, no exec, no per-job interference. Audited.
 */
export function setWorkerStateAdmin(requestId: string | null, ref: string, desired: WorkerDesiredState) {
  const result = setWorkerDesiredStateByRef(ref, desired);
  recordAuditEvent({ userId: null, type: "admin_worker_state", detail: `${result.ref}:${desired}` });
  logger.warn("admin.worker_state", { requestId: requestId ?? undefined, workerRef: result.ref, desired });
  return result;
}

/**
 * Trigger reconciliation now: enqueues the idempotent interactive cleanup job
 * (stale sessions, orphaned containers, expired artifacts). Audited.
 */
export function reconcileNowAdmin(requestId: string | null): { jobId: string | null } {
  const { enqueueJob } = require("@/lib/jobs/queue") as typeof import("@/lib/jobs/queue");
  const { job } = enqueueJob({
    type: "INTERACTIVE_BROWSER_CLEANUP",
    userId: null,
    payload: { scope: "all" },
    maxAttempts: 2,
    priorityClass: "normal",
    idempotencyKey: `ibrowser-cleanup:admin:${Math.floor(Date.now() / 30_000)}`,
    skipBackpressure: true,
  });
  recordAuditEvent({ userId: null, type: "admin_reconcile", detail: job.id });
  logger.warn("admin.reconcile", { requestId: requestId ?? undefined, jobId: job.id });
  return { jobId: job.id };
}
