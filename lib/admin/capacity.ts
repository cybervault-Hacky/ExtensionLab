import "server-only";
import { getDb } from "@/lib/db/client";
import { RUNTIME_SLOT_STATUSES } from "@/lib/db/repositories/browser-sessions";
import { getConfig } from "@/lib/config/env";
import { allBreakerSnapshots } from "@/lib/runtime/breaker";
import { classForCode, type FailureClass } from "@/lib/observability/failure-class";
import { summarizeWorkerFleet } from "@/lib/jobs/worker-registry";
import { countSessionsByStatus } from "@/lib/db/repositories/browser-sessions";

/**
 * Capacity & failure reporting for operators and autoscalers (Phase 13
 * §46/§82/§83). Fleet-wide numbers come from the database; worker counters
 * come from the registry; process-local breaker state is labeled as such.
 * No secrets, no container ids, no hostnames.
 */

export interface QueueSignals {
  depthByStatus: Record<string, number>;
  oldestQueuedAgeMs: number | null;
  oldestQueuedType: string | null;
  depthByType: Array<{ type: string; count: number }>;
}

export function getQueueSignals(now = Date.now()): QueueSignals {
  const db = getDb();
  const byStatus = db
    .prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
    .all() as unknown as Array<{ status: string; n: number }>;
  const depthByStatus: Record<string, number> = {};
  for (const row of byStatus) depthByStatus[row.status] = Number(row.n);
  const oldest = db
    .prepare("SELECT type, created_at FROM jobs WHERE status IN ('queued','retrying') ORDER BY created_at ASC LIMIT 1")
    .get() as unknown as { type: string; created_at: number } | undefined;
  const byType = db
    .prepare("SELECT type, COUNT(*) AS n FROM jobs WHERE status IN ('queued','retrying') GROUP BY type ORDER BY n DESC LIMIT 20")
    .all() as unknown as Array<{ type: string; n: number }>;
  return {
    depthByStatus,
    oldestQueuedAgeMs: oldest ? Math.max(0, now - Number(oldest.created_at)) : null,
    oldestQueuedType: oldest?.type ?? null,
    depthByType: byType.map((row) => ({ type: row.type, count: Number(row.n) })),
  };
}

export interface CapacitySnapshot {
  interactiveBrowser: {
    globalLimit: number;
    activeSlots: number;
    /** Slot-holding statuses only (§11): STARTING/READY/ACTIVE/IDLE/STOPPING. */
    byStatus: Record<string, number>;
    queued: number;
  };
  workers: ReturnType<typeof summarizeWorkerFleet>;
  queue: QueueSignals;
  /** §46: signals an autoscaler can scale workers on. */
  signals: {
    queue_depth: number;
    queued_age_ms: number | null;
    active_sessions: number;
    worker_capacity: number;
    worker_utilization: number;
    browser_start_latency_p95_ms: number | null;
  };
}

export function getCapacitySnapshot(now = Date.now()): CapacitySnapshot {
  const db = getDb();
  const config = getConfig().interactiveBrowser;
  const placeholders = RUNTIME_SLOT_STATUSES.map(() => "?").join(",");
  const byStatusRows = db
    .prepare("SELECT status, COUNT(*) AS n FROM interactive_browser_sessions WHERE status IN (?, ?, ?, ?, ?, ?, ?, ?) GROUP BY status")
    .all("CREATED", "QUEUED", "STARTING", "READY", "ACTIVE", "IDLE", "STOPPING", "FAILED") as unknown as Array<{
    status: string;
    n: number;
  }>;
  const byStatus: Record<string, number> = {};
  let activeSlots = 0;
  for (const row of byStatusRows) {
    byStatus[row.status] = Number(row.n);
    if ((RUNTIME_SLOT_STATUSES as readonly string[]).includes(row.status)) activeSlots += Number(row.n);
  }
  const workers = summarizeWorkerFleet(now);
  const queue = getQueueSignals(now);
  const latency = browserStartLatencyP95();
  return {
    interactiveBrowser: {
      globalLimit: config.maxGlobalSessions,
      activeSlots,
      byStatus,
      queued: byStatus.QUEUED ?? 0,
    },
    workers,
    queue,
    signals: {
      queue_depth: (queue.depthByStatus.queued ?? 0) + (queue.depthByStatus.retrying ?? 0),
      queued_age_ms: queue.oldestQueuedAgeMs,
      active_sessions: activeSlots,
      worker_capacity: workers.totalConcurrency,
      worker_utilization: Number(workers.utilization.toFixed(3)),
      browser_start_latency_p95_ms: latency,
    },
  };
}

/** Latest p95 start latency observed by THIS process's metric registry. */
function browserStartLatencyP95(): number | null {
  try {
    const { metricsSnapshot } = require("@/lib/observability/metrics-registry") as typeof import("@/lib/observability/metrics-registry");
    const histogram = metricsSnapshot().histograms.find((entry) => entry.name === "interactive.session_start_latency");
    return histogram && histogram.count > 0 ? histogram.p95 : null;
  } catch {
    return null;
  }
}

export interface FailureSnapshot {
  windowHours: number;
  failedJobsByErrorCode: Array<{ errorCode: string; count: number; failureClass: FailureClass }>;
  failedJobsByClass: Array<{ failureClass: FailureClass; count: number }>;
  sessionsByStopReason: Array<{ stopReason: string; count: number }>;
  sessionsByStatus: Record<string, number>;
  /** Process-local circuit breakers (this instance only; workers report their own). */
  circuitBreakers: ReturnType<typeof allBreakerSnapshots>;
}

export function getFailureSnapshot(windowHours = 24): FailureSnapshot {
  const db = getDb();
  const since = Date.now() - windowHours * 3600_000;
  const failedJobs = db
    .prepare("SELECT COALESCE(error_code, 'UNKNOWN') AS errorCode, COUNT(*) AS n FROM jobs WHERE status = 'failed' AND finished_at >= ? GROUP BY error_code ORDER BY n DESC LIMIT 25")
    .all(since) as unknown as Array<{ errorCode: string; n: number }>;
  const stopReasons = db
    .prepare("SELECT COALESCE(stop_reason, 'unknown') AS stopReason, COUNT(*) AS n FROM interactive_browser_sessions WHERE stopped_at >= ? GROUP BY stop_reason ORDER BY n DESC LIMIT 25")
    .all(since) as unknown as Array<{ stopReason: string; n: number }>;
  const byClass = new Map<FailureClass, number>();
  for (const row of failedJobs) {
    const failureClass = classForCode(row.errorCode);
    byClass.set(failureClass, (byClass.get(failureClass) ?? 0) + Number(row.n));
  }
  return {
    windowHours,
    failedJobsByErrorCode: failedJobs.map((row) => ({ errorCode: row.errorCode, count: Number(row.n), failureClass: classForCode(row.errorCode) })),
    failedJobsByClass: [...byClass.entries()].map(([failureClass, count]) => ({ failureClass, count })).sort((a, b) => b.count - a.count),
    sessionsByStopReason: stopReasons.map((row) => ({ stopReason: row.stopReason, count: Number(row.n) })),
    sessionsByStatus: countSessionsByStatus(),
    circuitBreakers: allBreakerSnapshots(),
  };
}
