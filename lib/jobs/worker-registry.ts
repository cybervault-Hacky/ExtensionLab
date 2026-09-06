import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { WorkerRow } from "@/lib/db/schema/types";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";

/**
 * Worker lifecycle registry (Phase 13).
 *
 * Observed state is ALWAYS derived — never stored — so a crashed worker can
 * never appear healthy:
 *
 *   STARTING   fresh registration, no successful probe yet (ready_at NULL)
 *   READY      fresh heartbeat + ready_at set + not draining
 *   DRAINING   operator asked for drain (desired_state) or worker signalled
 *              shutdown (stopping) — finishes active jobs, claims nothing new
 *   UNHEALTHY  heartbeat older than the unhealthy window (jobs it holds are
 *              recovered through the existing expired-lease path)
 *   STOPPED    heartbeat older than the stopped window (about to be reaped)
 *   DISABLED   operator disabled the worker; it claims nothing until re-enabled
 *
 * Worker ids are internal. The admin surface exposes only short stable refs
 * (sha256 prefix) — never hostnames or raw identifiers.
 */

export type WorkerObservedState =
  | "STARTING"
  | "READY"
  | "DRAINING"
  | "UNHEALTHY"
  | "STOPPED"
  | "DISABLED";

export type WorkerDesiredState = "running" | "draining" | "disabled";

export interface WorkerCapabilities {
  jobTypes: string[];
  browsers: string[];
  resourceProfiles: string[];
  sandboxDriver: string;
}

/** Heartbeat must arrive within this window to count as healthy (§6). */
export const WORKER_UNHEALTHY_AFTER_MS = 60_000;
/** After this window without heartbeats the worker is considered STOPPED (§6). */
export const WORKER_STOPPED_AFTER_MS = 180_000;

export function classifyWorkerState(
  row: Pick<WorkerRow, "last_seen_at" | "stopping" | "desired_state" | "ready_at">,
  now = Date.now(),
): WorkerObservedState {
  const desired = normalizeDesiredState(row.desired_state);
  if (now - row.last_seen_at > WORKER_STOPPED_AFTER_MS) return "STOPPED";
  if (desired === "disabled") return "DISABLED";
  if (now - row.last_seen_at > WORKER_UNHEALTHY_AFTER_MS) return "UNHEALTHY";
  if (desired === "draining" || row.stopping === 1) return "DRAINING";
  if (row.ready_at === null) return "STARTING";
  return "READY";
}

export function normalizeDesiredState(value: unknown): WorkerDesiredState {
  return value === "draining" || value === "disabled" ? value : "running";
}

/** Stable non-reversible public reference for an internal worker id (§5). */
export function workerRef(workerId: string): string {
  return createHash("sha256").update(`worker:${workerId}`).digest("hex").slice(0, 12);
}

export interface WorkerRegistrationInput {
  id: string;
  startedAt: number;
  concurrency: number;
  activeJobs: number;
  sandboxAvailable: boolean | null;
  sandboxDetail?: string | null;
  stopping?: boolean;
  version?: string | null;
  capabilities?: WorkerCapabilities | null;
  readyAt?: number | null;
}

/** Upsert a worker registration/heartbeat row (Phase 13 columns included). */
export function upsertWorkerRegistration(input: WorkerRegistrationInput): void {
  const db = getDb();
  const readyAt = input.readyAt ?? null;
  db.prepare(
    `INSERT INTO workers (id, started_at, last_seen_at, concurrency, active_jobs, sandbox_available,
                          sandbox_detail, stopping, version, capabilities_json, ready_at, desired_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       concurrency = excluded.concurrency,
       active_jobs = excluded.active_jobs,
       sandbox_available = excluded.sandbox_available,
       sandbox_detail = excluded.sandbox_detail,
       stopping = excluded.stopping,
       version = COALESCE(excluded.version, workers.version),
       capabilities_json = COALESCE(excluded.capabilities_json, workers.capabilities_json),
       ready_at = COALESCE(workers.ready_at, excluded.ready_at)`,
  ).run(
    input.id,
    input.startedAt,
    Date.now(),
    input.concurrency,
    input.activeJobs,
    input.sandboxAvailable === null ? null : input.sandboxAvailable ? 1 : 0,
    input.sandboxDetail ?? null,
    input.stopping ? 1 : 0,
    input.version ?? null,
    input.capabilities ? JSON.stringify(boundedCapabilities(input.capabilities)) : null,
    readyAt,
  );
}

function boundedCapabilities(capabilities: WorkerCapabilities): WorkerCapabilities {
  const bound = (values: string[] | undefined, max: number) =>
    Array.isArray(values) ? values.filter((value): value is string => typeof value === "string").slice(0, max) : [];
  return {
    jobTypes: bound(capabilities.jobTypes, 32),
    browsers: bound(capabilities.browsers, 16),
    resourceProfiles: bound(capabilities.resourceProfiles, 8),
    sandboxDriver: String(capabilities.sandboxDriver ?? "unknown").slice(0, 40),
  };
}

function parseCapabilities(json: string | null): WorkerCapabilities | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as WorkerCapabilities;
  } catch {
    return null;
  }
}

export interface WorkerStatusView {
  ref: string;
  state: WorkerObservedState;
  desiredState: WorkerDesiredState;
  version: string | null;
  capabilities: WorkerCapabilities | null;
  concurrency: number;
  activeJobs: number;
  sandboxAvailable: boolean | null;
  sandboxDetail: string | null;
  startedAt: number;
  readyAt: number | null;
  lastHeartbeatAt: number;
  lastHeartbeatAgeMs: number;
}

/** Admin view of all registered workers. Never exposes raw worker ids. */
export function listWorkerStatuses(now = Date.now()): WorkerStatusView[] {
  const rows = getDb()
    .prepare("SELECT * FROM workers ORDER BY last_seen_at DESC LIMIT 200")
    .all() as unknown as WorkerRow[];
  return rows.map((row) => {
    const state = classifyWorkerState(row, now);
    return {
      ref: workerRef(row.id),
      state,
      desiredState: normalizeDesiredState(row.desired_state),
      version: row.version,
      capabilities: parseCapabilities(row.capabilities_json),
      concurrency: row.concurrency,
      activeJobs: row.active_jobs,
      sandboxAvailable: row.sandbox_available === null ? null : row.sandbox_available === 1,
      sandboxDetail: row.sandbox_detail,
      startedAt: row.started_at,
      readyAt: row.ready_at,
      lastHeartbeatAt: row.last_seen_at,
      lastHeartbeatAgeMs: Math.max(0, now - row.last_seen_at),
    };
  });
}

export interface WorkerFleetSummary {
  total: number;
  byState: Record<WorkerObservedState, number>;
  ready: number;
  totalConcurrency: number;
  activeJobs: number;
  utilization: number;
}

export function summarizeWorkerFleet(now = Date.now()): WorkerFleetSummary {
  const workers = listWorkerStatuses(now);
  const byState = {
    STARTING: 0,
    READY: 0,
    DRAINING: 0,
    UNHEALTHY: 0,
    STOPPED: 0,
    DISABLED: 0,
  } as Record<WorkerObservedState, number>;
  let totalConcurrency = 0;
  let schedulableConcurrency = 0;
  let activeJobs = 0;
  for (const worker of workers) {
    byState[worker.state] += 1;
    totalConcurrency += worker.concurrency;
    activeJobs += worker.activeJobs;
    if (worker.state === "READY" || worker.state === "STARTING") schedulableConcurrency += worker.concurrency;
  }
  return {
    total: workers.length,
    byState,
    ready: byState.READY,
    totalConcurrency,
    activeJobs,
    utilization: schedulableConcurrency > 0 ? Math.min(1, activeJobs / schedulableConcurrency) : 0,
  };
}

/**
 * Operator control (§7/§57): set a worker's desired scheduling state.
 * `draining`/`disabled` stop new claims on the worker's next poll; `running`
 * re-enables. The worker observes the change through its own heartbeat read
 * and drains cooperatively (finish active jobs, then stop claiming). Audited
 * by callers.
 */
export function setWorkerDesiredStateByRef(ref: string, desired: WorkerDesiredState): { ref: string; desiredState: WorkerDesiredState } {
  const rows = getDb().prepare("SELECT id FROM workers").all() as unknown as Array<{ id: string }>;
  const match = rows.find((row) => workerRef(row.id) === ref || row.id === ref);
  if (!match) throw new AppError("NOT_FOUND", { message: "Worker not found." });
  getDb().prepare("UPDATE workers SET desired_state = ? WHERE id = ?").run(desired, match.id);
  recordMetric("worker.desired_state_changed", 1, { desired });
  logger.warn("worker.desired_state_changed", { component: "registry", workerRef: workerRef(match.id), desired });
  return { ref: workerRef(match.id), desiredState: desired };
}

/** The worker's own view of its desired state (polled each scheduling tick). */
export function getWorkerDesiredState(workerId: string): WorkerDesiredState {
  const row = getDb().prepare("SELECT desired_state FROM workers WHERE id = ?").get(workerId) as
    | { desired_state: unknown }
    | undefined;
  return normalizeDesiredState(row?.desired_state);
}

/**
 * A worker accepts new job claims only when it is not draining/disabled.
 * UNHEALTHY/STOPPED are observed by OTHERS (derived from heartbeat age); the
 * worker itself keeps claiming while its heartbeat is fresh — a live worker
 * whose heartbeat write raced must not starve its active jobs.
 */
export function workerAcceptsClaims(row: Pick<WorkerRow, "last_seen_at" | "stopping" | "desired_state" | "ready_at">, now = Date.now()): boolean {
  const state = classifyWorkerState(row, now);
  return state === "READY" || state === "STARTING";
}

export function getWorkerRow(workerId: string): WorkerRow | null {
  return (getDb().prepare("SELECT * FROM workers WHERE id = ?").get(workerId) as unknown as WorkerRow | undefined) ?? null;
}
