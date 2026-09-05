import {
  appendJobEvent,
  claimNextJob,
  completeJob,
  countRunningJobsForUser,
  failJob,
  getJobById,
  isCancelRequested,
  listExpiredLeases,
  listRunningJobsForWorker,
  markCancelled,
  recoverOrphanedJob,
  redactJobPayload,
  removeWorker,
  renewLease,
  scheduleRetry,
  upsertWorkerHeartbeat,
  type JobRow,
  type JobType,
} from "@/lib/db/repositories/jobs";
import { finalizeTestRunWithoutResults, getTestRunById } from "@/lib/db/repositories/test-runs";
import { releaseReservationForResource } from "@/lib/db/repositories/quota";
import { getConfig } from "@/lib/config/env";
import { AppError, classifyError, scrubDiagnostic } from "@/lib/observability/errors";
import { logger, recordMetric, withLogContext } from "@/lib/observability/logger";
import { decideRetry } from "./retry";
import { parsePayload } from "./queue";
import type { JobContext, JobHandler, JobPayloadMap, WorkerHealth } from "./types";

export interface WorkerOptions {
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  jobTimeoutMs?: number;
  shutdownGraceMs?: number;
  /** Per-user cap on simultaneously running AUTOMATED_TEST jobs. */
  userConcurrency?: number;
  /** Reports sandbox availability in heartbeats (never exposed to clients directly). */
  sandboxProbe?: () => Promise<{ available: boolean; detail?: string }>;
  types?: readonly JobType[];
}

interface ActiveJob {
  job: JobRow;
  controller: AbortController;
  handler: JobHandler;
  context: JobContext;
  promise: Promise<void>;
}

/**
 * Background worker.
 *
 * - Claims jobs atomically (conditional UPDATE) so multiple workers are safe.
 * - Renews leases while a job runs; jobs whose lease expires (crash/SIGKILL)
 *   are recovered on the next startup or by any live worker's sweep.
 * - Retries only transient failures with exponential backoff.
 * - Cancellation is cooperative and idempotent.
 * - Graceful shutdown: stop claiming, cancel/finish active jobs within the
 *   grace period, destroy sandboxes, flush state, then resolve.
 */
export class JobWorker {
  readonly workerId: string;
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly active = new Map<string, ActiveJob>();
  private readonly options: Required<Omit<WorkerOptions, "sandboxProbe" | "types">> & Pick<WorkerOptions, "sandboxProbe" | "types">;
  private stopping = false;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly startedAt = Date.now();
  private lastSandbox: { available: boolean | null; detail?: string } = { available: null };
  private lastHeartbeatAt = 0;
  private lastSweepAt = 0;

  constructor(options: WorkerOptions = {}) {
    const config = getConfig();
    this.workerId = options.workerId ?? config.jobs.workerId;
    this.options = {
      workerId: this.workerId,
      concurrency: options.concurrency ?? config.jobs.workerConcurrency,
      pollIntervalMs: options.pollIntervalMs ?? config.jobs.pollIntervalMs,
      leaseMs: options.leaseMs ?? config.jobs.leaseMs,
      jobTimeoutMs: options.jobTimeoutMs ?? config.jobs.jobTimeoutMs,
      shutdownGraceMs: options.shutdownGraceMs ?? config.jobs.shutdownGraceMs,
      userConcurrency: options.userConcurrency ?? config.sandbox.userConcurrency,
      sandboxProbe: options.sandboxProbe,
      types: options.types,
    };
  }

  register<T extends JobType>(handler: JobHandler<T>): this {
    this.handlers.set(handler.type, handler as unknown as JobHandler);
    return this;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get activeCount(): number {
    return this.active.size;
  }

  health(): WorkerHealth {
    return {
      workerId: this.workerId,
      startedAt: this.startedAt,
      activeJobs: this.active.size,
      concurrency: this.options.concurrency,
      sandboxAvailable: this.lastSandbox.available,
      stopping: this.stopping,
    };
  }

  /** Starts the polling loop. Resolves immediately; use `stop()` to shut down. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.recoverOrphans("startup");
    void this.heartbeat();
    this.loopPromise = this.loop();
    logger.info("worker.started", { component: "worker", concurrency: this.options.concurrency });
  }

  /** Processes at most one claimable job and returns whether one ran (for tests/embedded mode). */
  async tick(): Promise<boolean> {
    const claimed = this.claim();
    if (!claimed) return false;
    await this.run(claimed);
    return true;
  }

  /** Drains the queue until nothing is claimable (tests/embedded mode). */
  async drain(maxJobs = 100): Promise<number> {
    let count = 0;
    while (count < maxJobs && (await this.tick())) count += 1;
    return count;
  }

  /** Wakes the loop early (e.g. after an enqueue in embedded mode). */
  notify(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.wake?.();
    logger.info("worker.stopping", { component: "worker", activeJobs: this.active.size });
    await this.heartbeat();

    const deadline = Date.now() + this.options.shutdownGraceMs;
    // Ask every active job to cancel cooperatively (sandboxes are destroyed by handlers).
    for (const entry of this.active.values()) {
      entry.controller.abort();
      if (entry.handler.cancel) {
        await entry.handler.cancel(entry.context).catch(() => undefined);
      }
    }
    while (this.active.size > 0 && Date.now() < deadline) {
      await sleep(50);
    }
    for (const entry of this.active.values()) {
      // Grace period elapsed: mark as retrying so another worker can pick it up.
      logger.warn("worker.job_abandoned", { jobId: entry.job.id, component: "worker" });
      scheduleRetry(entry.job.id, Date.now(), "WORKER_UNAVAILABLE", "Worker shut down before the job finished.");
    }
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    try {
      removeWorker(this.workerId);
    } catch {
      // Database may already be closed.
    }
    logger.info("worker.stopped", { component: "worker" });
  }

  /** Recovers jobs whose lease expired (any worker) and this worker's own leftovers. */
  recoverOrphans(reason: "startup" | "sweep"): number {
    let recovered = 0;
    const own = reason === "startup" ? listRunningJobsForWorker(this.workerId) : [];
    const expired = listExpiredLeases();
    const seen = new Set<string>();
    for (const job of [...own, ...expired]) {
      if (seen.has(job.id) || this.active.has(job.id)) continue;
      seen.add(job.id);
      const outcome = recoverOrphanedJob(job, { retryable: job.type !== "EMAIL" ? true : true });
      this.afterOrphanRecovery(job, outcome);
      recovered += 1;
      logger.warn("worker.orphan_recovered", { jobId: job.id, component: "worker", result: outcome, reason });
    }
    return recovered;
  }

  private afterOrphanRecovery(job: JobRow, outcome: "requeued" | "failed"): void {
    appendJobEvent({
      jobId: job.id,
      kind: "state",
      stage: outcome === "requeued" ? "Queued" : "Completed",
      payload: { type: "state", state: outcome === "requeued" ? "queued" : "failed", recovered: true },
    });
    if (job.type !== "AUTOMATED_TEST") return;
    const payload = parsePayload<"AUTOMATED_TEST">(job);
    if (!payload.runId) return;
    const run = getTestRunById(payload.runId);
    if (!run || ["completed", "failed", "timeout", "destroyed"].includes(run.status)) return;
    if (outcome === "failed") {
      finalizeTestRunWithoutResults({
        id: payload.runId,
        status: "failed",
        outcome: "INFRASTRUCTURE_ERROR",
        errorCode: "WORKER_UNAVAILABLE",
        reason: "The worker processing this run stopped unexpectedly.",
      });
      releaseReservationForResource(payload.runId);
    } else {
      // Sandbox state from the crashed worker is gone; the run restarts from scratch.
      getTestRunById(payload.runId);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let claimedAny = false;
      try {
        if (Date.now() - this.lastSweepAt > Math.max(this.options.leaseMs, 5000)) {
          this.lastSweepAt = Date.now();
          this.recoverOrphans("sweep");
        }
        while (!this.stopping && this.active.size < this.options.concurrency) {
          const job = this.claim();
          if (!job) break;
          claimedAny = true;
          void this.run(job);
        }
        if (Date.now() - this.lastHeartbeatAt > Math.min(this.options.leaseMs / 2, 5000)) {
          await this.heartbeat();
        }
      } catch (error) {
        logger.error("worker.loop_error", { component: "worker", errorCode: classifyError(error).code });
      }
      if (!claimedAny) await this.waitForWork();
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      // Intentionally not unref'd: the poll timer is what keeps a dedicated
      // worker process alive between jobs. `stop()` resolves it early.
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.options.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private claim(): JobRow | null {
    const types = (this.options.types ?? [...this.handlers.keys()]).filter((type) => this.handlers.has(type));
    if (types.length === 0) return null;
    // Per-user concurrency: users already running an AUTOMATED_TEST are skipped.
    const excludeUserIds = new Set<string>();
    for (const entry of this.active.values()) {
      if (entry.job.type === "AUTOMATED_TEST" && entry.job.user_id) {
        if (countRunningJobsForUser(entry.job.user_id, "AUTOMATED_TEST") >= this.options.userConcurrency) {
          excludeUserIds.add(entry.job.user_id);
        }
      }
    }
    return claimNextJob({
      workerId: this.workerId,
      types,
      leaseMs: this.options.leaseMs,
      excludeUserIds: [...excludeUserIds],
    });
  }

  private async run(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type as JobType);
    if (!handler) {
      failJob(job.id, "INTERNAL", "No handler registered for this job type.");
      return;
    }
    const controller = new AbortController();
    const context = this.createContext(job, controller);
    const entry: ActiveJob = { job, controller, handler, context, promise: Promise.resolve() };
    this.active.set(job.id, entry);
    const startedAt = Date.now();

    entry.promise = withLogContext({ jobId: job.id, userId: job.user_id ?? undefined, component: "worker" }, async () => {
      appendJobEvent({ jobId: job.id, kind: "state", stage: null, payload: { type: "state", state: "running", attempt: job.attempts } });
      logger.info("job.started", { type: job.type, attempt: job.attempts });
      const timeout = setTimeout(() => controller.abort(new AppError("JOB_TIMEOUT")), this.options.jobTimeoutMs);
      timeout.unref?.();
      try {
        const result = await handler.handle(context);
        clearTimeout(timeout);
        if (isCancelRequested(job.id) || controller.signal.aborted) {
          await this.finishCancelled(job, handler, context);
        } else {
          completeJob(job.id, (result as Record<string, unknown> | undefined) ?? null);
          appendJobEvent({ jobId: job.id, kind: "state", stage: "Completed", payload: { type: "state", state: "completed" } });
          recordMetric("job.completed", 1, { type: job.type });
          logger.info("job.completed", { type: job.type, durationMs: Date.now() - startedAt, result: "completed" });
        }
      } catch (error) {
        clearTimeout(timeout);
        if (isCancelRequested(job.id) || (controller.signal.aborted && !(controller.signal.reason instanceof AppError && controller.signal.reason.code === "JOB_TIMEOUT"))) {
          await this.finishCancelled(job, handler, context);
          return;
        }
        const timedOut = controller.signal.reason instanceof AppError && controller.signal.reason.code === "JOB_TIMEOUT";
        const decision = timedOut
          ? { retry: false, delayMs: 0, code: "JOB_TIMEOUT" as const, userMessage: "The job exceeded its time limit." }
          : decideRetry(error, job.attempts, job.max_attempts);
        const detail = scrubDiagnostic(error instanceof Error ? error.message : String(error));
        if (decision.retry) {
          scheduleRetry(job.id, Date.now() + decision.delayMs, decision.code, detail);
          appendJobEvent({
            jobId: job.id,
            kind: "state",
            stage: "Queued",
            payload: { type: "state", state: "retrying", attempt: job.attempts, delayMs: decision.delayMs, errorCode: decision.code },
          });
          recordMetric("job.retried", 1, { type: job.type, code: decision.code });
          logger.warn("job.retry_scheduled", { type: job.type, attempt: job.attempts, delayMs: decision.delayMs, errorCode: decision.code });
        } else {
          failJob(job.id, decision.code, detail);
          appendJobEvent({
            jobId: job.id,
            kind: "state",
            stage: "Completed",
            payload: { type: "state", state: "failed", errorCode: decision.code, reason: decision.userMessage },
          });
          if (timedOut && handler.cancel) await handler.cancel(context).catch(() => undefined);
          if (timedOut && job.type === "AUTOMATED_TEST") this.finalizeTimedOutRun(job);
          recordMetric("job.failed", 1, { type: job.type, code: decision.code });
          logger.error("job.failed", { type: job.type, attempt: job.attempts, errorCode: decision.code, durationMs: Date.now() - startedAt });
        }
      } finally {
        if (handler.redactPayloadOnFinish) {
          try {
            redactJobPayload(job.id);
          } catch {
            // Best-effort; retention cleanup removes the row eventually.
          }
        }
        this.active.delete(job.id);
        this.wake?.();
      }
    });
    await entry.promise;
  }

  private finalizeTimedOutRun(job: JobRow): void {
    const payload = parsePayload<"AUTOMATED_TEST">(job);
    if (!payload.runId) return;
    const run = getTestRunById(payload.runId);
    if (!run || ["completed", "failed", "timeout", "destroyed"].includes(run.status)) return;
    finalizeTestRunWithoutResults({
      id: payload.runId,
      status: "timeout",
      outcome: "TIMEOUT",
      errorCode: "JOB_TIMEOUT",
      reason: "The job exceeded its time limit.",
    });
    releaseReservationForResource(payload.runId);
  }

  private async finishCancelled(job: JobRow, handler: JobHandler, context: JobContext): Promise<void> {
    if (handler.cancel) await handler.cancel(context).catch(() => undefined);
    markCancelled(job.id);
    appendJobEvent({ jobId: job.id, kind: "state", stage: "Completed", payload: { type: "state", state: "cancelled" } });
    recordMetric("job.cancelled", 1, { type: job.type });
    logger.info("job.cancelled", { type: job.type, result: "cancelled" });
  }

  private createContext(job: JobRow, controller: AbortController): JobContext {
    const worker = this;
    let lastCancelCheck = 0;
    let cancelled = false;
    return {
      job,
      payload: parsePayload(job) as JobPayloadMap[JobType],
      signal: controller.signal,
      isCancelled(force = false): boolean {
        if (controller.signal.aborted || worker.stopping) return true;
        if (cancelled) return true;
        const now = Date.now();
        if (force || now - lastCancelCheck > 250) {
          lastCancelCheck = now;
          try {
            cancelled = isCancelRequested(job.id);
          } catch {
            cancelled = false;
          }
        }
        return cancelled;
      },
      heartbeat(): void {
        renewLease(job.id, worker.workerId, worker.options.leaseMs);
      },
      emit(kind: string, payload: Record<string, unknown>, stage?: string): void {
        appendJobEvent({ jobId: job.id, kind, stage: stage ?? null, payload });
      },
    };
  }

  private async heartbeat(): Promise<void> {
    this.lastHeartbeatAt = Date.now();
    if (this.options.sandboxProbe) {
      try {
        const probe = await this.options.sandboxProbe();
        this.lastSandbox = { available: probe.available, detail: probe.detail };
      } catch {
        this.lastSandbox = { available: false, detail: "probe_failed" };
      }
    }
    try {
      upsertWorkerHeartbeat({
        id: this.workerId,
        startedAt: this.startedAt,
        concurrency: this.options.concurrency,
        activeJobs: this.active.size,
        sandboxAvailable: this.lastSandbox.available,
        sandboxDetail: this.lastSandbox.detail ?? null,
        stopping: this.stopping,
      });
    } catch (error) {
      logger.warn("worker.heartbeat_failed", { component: "worker", errorCode: classifyError(error).code });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { getJobById };
