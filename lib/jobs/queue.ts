import { getDb, transaction } from "@/lib/db/client";
import {
  appendJobEvent,
  countActiveJobsForUser,
  countQueuedJobs,
  getJobById,
  getJobByIdempotencyKey,
  getOwnedJob,
  insertJob,
  isTerminalJobStatus,
  listJobEvents,
  queuePosition,
  requestCancel,
  type JobRow,
  type JobStatus,
  type JobType,
} from "@/lib/db/repositories/jobs";
import { getConfig } from "@/lib/config/env";
import type { JobPriorityClass } from "./types";
import { AppError, isErrorCode } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import type { JobPayloadMap, JobView } from "./types";

/**
 * Queue API used by the web process. Everything is persisted in SQLite; the
 * worker polls with `claimNextJob`. Enqueueing is synchronous and cheap so web
 * requests never block on execution.
 */

export type { JobPriorityClass };

export interface EnqueueOptions<T extends JobType> {
  type: T;
  userId: string | null;
  /** Phase 10: organization that owns this job (fair scheduling + quotas). */
  organizationId?: string | null;
  /** Priority class resolved through config; raw numeric priorities are clamped. */
  priorityClass?: JobPriorityClass;
  payload: JobPayloadMap[T];
  maxAttempts?: number;
  priority?: number;
  idempotencyKey?: string;
  resourceType?: string;
  resourceId?: string;
  runAfter?: number;
  /** Extra work to run in the same transaction (e.g. quota reservation, run row). */
  within?: (job: JobRow) => void;
  /** Skip queue back-pressure checks (internal maintenance jobs). */
  skipBackpressure?: boolean;
  /** Per-user active-job cap for this enqueue (defaults to JOB_MAX_QUEUED_PER_USER). */
  maxActivePerUser?: number;
}

export function enqueueJob<T extends JobType>(options: EnqueueOptions<T>): { job: JobRow; created: boolean } {
  const config = getConfig();
  const db = getDb();
  return transaction(db, () => {
    if (options.idempotencyKey) {
      const existing = getJobByIdempotencyKey(options.idempotencyKey);
      if (existing) return { job: existing, created: false };
    }
    if (!options.skipBackpressure) {
      if (countQueuedJobs() >= config.jobs.maxQueueLength) {
        throw new AppError("QUEUE_FULL");
      }
      const perUserCap = Math.max(options.maxActivePerUser ?? 0, config.jobs.maxQueuedPerUser);
      if (options.userId && countActiveJobsForUser(options.userId, options.type) >= perUserCap) {
        throw new AppError("CONCURRENCY_LIMIT", {
          message: "You already have the maximum number of queued runs. Wait for one to finish.",
        });
      }
    }
    const priority = resolvePriority(options, config);
    const job = insertJob({
      type: options.type,
      userId: options.userId,
      organizationId: options.organizationId ?? null,
      payload: options.payload as unknown as Record<string, unknown>,
      maxAttempts: options.maxAttempts ?? config.jobs.maxRetries + 1,
      priority,
      idempotencyKey: options.idempotencyKey ?? null,
      resourceType: options.resourceType ?? null,
      resourceId: options.resourceId ?? null,
      runAfter: options.runAfter,
    });
    options.within?.(job);
    appendJobEvent({ jobId: job.id, kind: "state", stage: "Queued", payload: { type: "state", state: "queued", stage: "Queued" } });
    recordMetric("job.enqueued", 1, { type: options.type });
    logger.info("job.enqueued", { jobId: job.id, userId: options.userId ?? undefined, type: options.type });
    return { job, created: true };
  });
}

/**
 * Priority classes are fixed by configuration and can never exceed the
 * configured ceilings — priority never bypasses security, capacity or plan
 * limits (backpressure checks run regardless).
 */
function resolvePriority(options: { priority?: number; priorityClass?: JobPriorityClass }, config: ReturnType<typeof getConfig>): number {
  const classes = config.jobs10;
  const byClass: Record<JobPriorityClass, number> = {
    interactive: classes.priorityInteractive,
    enterprise: classes.priorityEnterprise,
    ci: classes.priorityCi,
    normal: classes.priorityNormal,
  };
  const base = options.priorityClass ? byClass[options.priorityClass] : (options.priority ?? classes.priorityNormal);
  return Math.max(-100, Math.min(100, Math.floor(base)));
}

export function toJobView(job: JobRow): JobView {
  return {
    id: job.id,
    type: job.type as JobType,
    status: job.status as JobStatus,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    errorCode: isErrorCode(job.error_code) ? job.error_code : null,
    queuePosition: queuePosition(job),
    resourceType: job.resource_type,
    resourceId: job.resource_id,
  };
}

export function getOwnedJobView(userId: string, jobId: string): JobView | null {
  const job = getOwnedJob(userId, jobId);
  return job ? toJobView(job) : null;
}

export function parsePayload<T extends JobType>(job: JobRow): JobPayloadMap[T] {
  try {
    return JSON.parse(job.payload_json) as JobPayloadMap[T];
  } catch {
    return {} as JobPayloadMap[T];
  }
}

/**
 * Cancels a job. Queued jobs are cancelled immediately; running jobs are
 * flagged and the worker cancels cooperatively (stops the sandbox, destroys
 * the container, marks the job cancelled). Idempotent.
 */
export function cancelJob(jobId: string): { status: JobStatus | null; changed: boolean } {
  const result = requestCancel(jobId);
  if (result.changed) {
    appendJobEvent({
      jobId,
      kind: "state",
      stage: result.status === "cancelled" ? "Completed" : null,
      payload: { type: "state", state: result.status === "cancelled" ? "cancelled" : "stopping", cancelRequested: true },
    });
    logger.info("job.cancel_requested", { jobId, result: result.status ?? "unknown" });
  }
  return result;
}

export function isJobFinished(jobId: string): boolean {
  const job = getJobById(jobId);
  return !job || isTerminalJobStatus(job.status);
}

export function getJobEventsAfter(jobId: string, afterId: number): Array<{ id: number; payload: string }> {
  return listJobEvents(jobId, afterId).map((row) => ({ id: row.id, payload: row.payload }));
}
