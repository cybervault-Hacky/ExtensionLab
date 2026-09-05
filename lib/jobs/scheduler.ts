import { enqueueJob } from "./queue";
import { getConfig } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";

/**
 * Periodic scheduler. Instead of running maintenance inline, it enqueues an
 * ARTIFACT_CLEANUP job with an idempotency key per interval window so that
 * several web/worker replicas never schedule duplicate work.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(intervalMs = getConfig().jobs.cleanupIntervalMs) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.scheduleCleanup();
    this.timer = setInterval(() => this.scheduleCleanup(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Enqueues (at most once per window) the cleanup job. Returns the job id. */
  scheduleCleanup(now = Date.now()): string | null {
    const window = Math.floor(now / this.intervalMs);
    try {
      const { job } = enqueueJob({
        type: "ARTIFACT_CLEANUP",
        userId: null,
        payload: { scope: "all" },
        maxAttempts: 2,
        priority: -10,
        idempotencyKey: `cleanup:${window}`,
        skipBackpressure: true,
      });
      return job.id;
    } catch (error) {
      logger.warn("scheduler.enqueue_failed", { component: "scheduler", detail: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  }
}
