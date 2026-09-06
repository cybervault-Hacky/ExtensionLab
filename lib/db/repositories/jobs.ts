import { getDb, transaction } from "../client";
import { generateDbId } from "../ids";
import type { JobEventRow, JobRow } from "../schema/types";

export type { JobEventRow, JobRow };

/**
 * Job repository. State transitions are expressed as conditional UPDATEs so
 * that two workers (or a worker and the web process) can never both win the
 * same transition.
 */

export const JOB_TYPES = [
  "ANALYSIS",
  "AUTOMATED_TEST",
  "REPORT_GENERATION",
  "ARTIFACT_CLEANUP",
  "EMAIL",
  "WEBHOOK_DELIVERY",
  "ORG_EXPORT",
  "INTERACTIVE_BROWSER_START",
  "INTERACTIVE_BROWSER_STOP",
  "INTERACTIVE_BROWSER_CLEANUP",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "retrying",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled", "expired"];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "retrying"];

export function isTerminalJobStatus(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

export function insertJob(input: {
  id?: string;
  type: JobType;
  userId: string | null;
  organizationId?: string | null;
  payload: Record<string, unknown>;
  maxAttempts: number;
  priority?: number;
  idempotencyKey?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  runAfter?: number;
}): JobRow {
  const db = getDb();
  const now = Date.now();
  const id = input.id ?? generateDbId("job");
  db.prepare(
    `INSERT INTO jobs
      (id, type, user_id, organization_id, status, priority, attempts, max_attempts, payload_json, idempotency_key,
       resource_type, resource_id, run_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.type,
    input.userId,
    input.organizationId ?? null,
    input.priority ?? 0,
    Math.max(1, input.maxAttempts),
    JSON.stringify(input.payload ?? {}),
    input.idempotencyKey ?? null,
    input.resourceType ?? null,
    input.resourceId ?? null,
    input.runAfter ?? now,
    now,
    now,
  );
  return getJobById(id)!;
}

/** Running-job counts per organization (fair scheduling, Phase 10). */
export function countRunningJobsForOrganization(organizationId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ? AND status = 'running'")
    .get(organizationId) as { n: number };
  return Number(row.n);
}

/** Active (queued/running/retrying) counts per organization. */
export function countActiveJobsForOrganization(organizationId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ? AND status IN ('queued','running','retrying')")
    .get(organizationId) as { n: number };
  return Number(row.n);
}

export function getJobById(id: string): JobRow | null {
  return (getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null;
}

export function getJobByIdempotencyKey(key: string): JobRow | null {
  return (
    (getDb().prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key) as JobRow | undefined) ?? null
  );
}

export function getJobForResource(resourceType: string, resourceId: string): JobRow | null {
  return (
    (getDb()
      .prepare(
        "SELECT * FROM jobs WHERE resource_type = ? AND resource_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(resourceType, resourceId) as JobRow | undefined) ?? null
  );
}

export function getOwnedJob(userId: string, id: string): JobRow | null {
  return (
    (getDb().prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(id, userId) as JobRow | undefined) ??
    null
  );
}

export function countActiveJobsForUser(userId: string, type?: JobType): number {
  const db = getDb();
  const row = type
    ? (db
        .prepare(
          "SELECT COUNT(*) AS total FROM jobs WHERE user_id = ? AND type = ? AND status IN ('queued','running','retrying')",
        )
        .get(userId, type) as { total: number })
    : (db
        .prepare("SELECT COUNT(*) AS total FROM jobs WHERE user_id = ? AND status IN ('queued','running','retrying')")
        .get(userId) as { total: number });
  return row.total;
}

export function countRunningJobsForUser(userId: string, type: JobType): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS total FROM jobs WHERE user_id = ? AND type = ? AND status = 'running'")
      .get(userId, type) as { total: number }
  ).total;
}

export function countJobsByStatus(): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS total FROM jobs GROUP BY status")
    .all() as unknown as Array<{ status: string; total: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.total;
  return out;
}

export function countQueuedJobs(type?: JobType): number {
  const db = getDb();
  const row = type
    ? (db
        .prepare("SELECT COUNT(*) AS total FROM jobs WHERE type = ? AND status IN ('queued','retrying')")
        .get(type) as { total: number })
    : (db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE status IN ('queued','retrying')").get() as {
        total: number;
      });
  return row.total;
}

/** 1-based position of a queued job among jobs of the same type that run before it. */
export function queuePosition(job: JobRow): number | null {
  if (job.status !== "queued" && job.status !== "retrying") return null;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS ahead FROM jobs
       WHERE type = ? AND status IN ('queued','retrying')
         AND (priority > ? OR (priority = ? AND (run_after < ? OR (run_after = ? AND created_at < ?))))`,
    )
    .get(job.type, job.priority, job.priority, job.run_after, job.run_after, job.created_at) as { ahead: number };
  return row.ahead + 1;
}

/**
 * Atomically claims the next runnable job for a worker. Uses a conditional
 * UPDATE ... RETURNING guarded by the current status so concurrent workers can
 * never claim the same row.
 */
export function claimNextJob(input: {
  workerId: string;
  types: readonly JobType[];
  leaseMs: number;
  excludeUserIds?: string[];
  /** Phase 10 fairness: max simultaneously running jobs per organization. */
  orgConcurrency?: (organizationId: string) => number;
  /** How many queued candidates to examine for fairness (bounded scan). */
  scanLimit?: number;
}): JobRow | null {
  if (input.types.length === 0) return null;
  const db = getDb();
  const now = Date.now();
  const typePlaceholders = input.types.map(() => "?").join(",");
  const exclude = input.excludeUserIds ?? [];
  const excludeSql = exclude.length > 0 ? `AND (user_id IS NULL OR user_id NOT IN (${exclude.map(() => "?").join(",")}))` : "";
  const scanLimit = Math.min(Math.max(input.scanLimit ?? 50, 1), 500);

  return transaction(db, () => {
    const candidates = db
      .prepare(
        `SELECT id, organization_id FROM jobs
         WHERE status IN ('queued','retrying')
           AND run_after <= ?
           AND type IN (${typePlaceholders})
           ${excludeSql}
         ORDER BY priority DESC, run_after ASC, created_at ASC
         LIMIT ?`,
      )
      .all(now, ...input.types, ...exclude, scanLimit) as Array<{ id: string; organization_id: string | null }>;
    const candidate = pickFairCandidate(db, candidates, input.orgConcurrency);
    if (!candidate) return null;
    const rows = db
      .prepare(
        `UPDATE jobs
         SET status = 'running', worker_id = ?, lease_expires_at = ?, attempts = attempts + 1,
             started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND status IN ('queued','retrying')
         RETURNING *`,
      )
      .all(input.workerId, now + input.leaseMs, now, now, candidate.id) as unknown as JobRow[];
    return rows[0] ?? null;
  });
}

export /**
 * Fairness-aware candidate selection: walks the bounded candidate list and
 * picks the first job whose organization is below its concurrency cap. Jobs
 * without an organization are always eligible. One organization can therefore
 * never monopolize the worker fleet while others wait.
 */
function pickFairCandidate(
  db: import("@/lib/db/client").DB,
  candidates: Array<{ id: string; organization_id: string | null }>,
  orgConcurrency?: (organizationId: string) => number,
): { id: string } | null {
  if (!orgConcurrency) return candidates[0] ?? null;
  const runningByOrg = new Map<string, number>();
  const orgRows = db
    .prepare("SELECT organization_id, COUNT(*) AS n FROM jobs WHERE status = 'running' AND organization_id IS NOT NULL GROUP BY organization_id")
    .all() as Array<{ organization_id: string; n: number }>;
  for (const row of orgRows) runningByOrg.set(row.organization_id, Number(row.n));
  for (const candidate of candidates) {
    if (!candidate.organization_id) return candidate;
    const cap = Math.max(1, orgConcurrency(candidate.organization_id));
    const running = runningByOrg.get(candidate.organization_id) ?? 0;
    if (running < cap) return candidate;
  }
  return null;
}

export function renewLease(jobId: string, workerId: string, leaseMs: number): boolean {
  const result = getDb()
    .prepare(
      "UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'",
    )
    .run(Date.now() + leaseMs, Date.now(), jobId, workerId);
  return result.changes > 0;
}

export function completeJob(jobId: string, result: Record<string, unknown> | null): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE jobs SET status = 'completed', result_json = ?, finished_at = ?, updated_at = ?, lease_expires_at = NULL
       WHERE id = ? AND status = 'running'`,
    )
    .run(result ? JSON.stringify(result) : null, now, now, jobId);
  return res.changes > 0;
}

export function failJob(jobId: string, errorCode: string, errorMessage: string | null): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?, updated_at = ?, lease_expires_at = NULL
       WHERE id = ? AND status IN ('running','queued','retrying')`,
    )
    .run(errorCode, errorMessage, now, now, jobId);
  return res.changes > 0;
}

/** Phase 10 admin path: requeue a terminal `failed` job (audited by callers). */
export function requeueFailedJob(jobId: string): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE jobs SET status = 'queued', run_after = ?, error_code = 'ADMIN_RETRY', error_message = NULL,
              updated_at = ?, worker_id = NULL, lease_expires_at = NULL, cancel_requested_at = NULL
       WHERE id = ? AND status = 'failed'`,
    )
    .run(now, now, jobId);
  return res.changes > 0;
}

export function scheduleRetry(jobId: string, runAfter: number, errorCode: string, errorMessage: string | null): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE jobs SET status = 'retrying', run_after = ?, error_code = ?, error_message = ?, updated_at = ?,
              worker_id = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'running'`,
    )
    .run(runAfter, errorCode, errorMessage, now, jobId);
  return res.changes > 0;
}

export function expireJob(jobId: string, errorCode = "JOB_TIMEOUT"): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE jobs SET status = 'expired', error_code = ?, finished_at = ?, updated_at = ?, lease_expires_at = NULL
       WHERE id = ? AND status IN ('queued','running','retrying')`,
    )
    .run(errorCode, now, now, jobId);
  return res.changes > 0;
}

/** Marks a queued/retrying job cancelled immediately, or flags a running one for cooperative cancellation. */
export function requestCancel(jobId: string): { status: JobStatus | null; changed: boolean } {
  const db = getDb();
  const now = Date.now();
  return transaction(db, () => {
    const job = getJobById(jobId);
    if (!job) return { status: null, changed: false };
    if (isTerminalJobStatus(job.status)) return { status: job.status as JobStatus, changed: false };
    if (job.status === "queued" || job.status === "retrying") {
      db.prepare(
        `UPDATE jobs SET status = 'cancelled', cancel_requested_at = ?, finished_at = ?, updated_at = ?, lease_expires_at = NULL
         WHERE id = ? AND status IN ('queued','retrying')`,
      ).run(now, now, now, jobId);
      return { status: "cancelled", changed: true };
    }
    // Running: idempotent cooperative cancellation. The worker observes
    // cancel_requested_at, stops the sandbox and marks the job cancelled.
    if (job.cancel_requested_at !== null) return { status: "running", changed: false };
    db.prepare("UPDATE jobs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?").run(now, now, jobId);
    return { status: "running", changed: true };
  });
}

export function markCancelled(jobId: string): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ?, lease_expires_at = NULL,
              cancel_requested_at = COALESCE(cancel_requested_at, ?)
       WHERE id = ? AND status IN ('queued','running','retrying')`,
    )
    .run(now, now, now, jobId);
  return res.changes > 0;
}

export function isCancelRequested(jobId: string): boolean {
  const row = getDb().prepare("SELECT cancel_requested_at, status FROM jobs WHERE id = ?").get(jobId) as
    | { cancel_requested_at: number | null; status: string }
    | undefined;
  return Boolean(row && (row.cancel_requested_at !== null || row.status === "cancelled"));
}

/** Running jobs whose lease expired (worker crashed or was killed). */
export function listExpiredLeases(now = Date.now()): JobRow[] {
  return getDb()
    .prepare("SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
    .all(now) as unknown as JobRow[];
}

export function listRunningJobsForWorker(workerId: string): JobRow[] {
  return getDb()
    .prepare("SELECT * FROM jobs WHERE status = 'running' AND worker_id = ?")
    .all(workerId) as unknown as JobRow[];
}

/** Requeues an orphaned running job (lease expired) or fails it when attempts are exhausted. */
export function recoverOrphanedJob(job: JobRow, opts: { retryable: boolean }): "requeued" | "failed" {
  const db = getDb();
  const now = Date.now();
  if (opts.retryable && job.attempts < job.max_attempts && job.cancel_requested_at === null) {
    db.prepare(
      `UPDATE jobs SET status = 'retrying', run_after = ?, worker_id = NULL, lease_expires_at = NULL,
              error_code = 'WORKER_UNAVAILABLE', error_message = 'Worker lease expired; job requeued.', updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(now, now, job.id);
    return "requeued";
  }
  db.prepare(
    `UPDATE jobs SET status = 'failed', error_code = 'WORKER_UNAVAILABLE',
            error_message = 'The worker processing this job stopped unexpectedly.',
            finished_at = ?, updated_at = ?, worker_id = NULL, lease_expires_at = NULL
     WHERE id = ? AND status = 'running'`,
  ).run(now, now, job.id);
  return "failed";
}

export function listStaleQueuedJobs(olderThan: number): JobRow[] {
  return getDb()
    .prepare("SELECT * FROM jobs WHERE status IN ('queued','retrying') AND created_at < ?")
    .all(olderThan) as unknown as JobRow[];
}

export function deleteFinishedJobsBefore(before: number): number {
  const result = getDb()
    .prepare(
      "DELETE FROM jobs WHERE status IN ('completed','failed','cancelled','expired') AND COALESCE(finished_at, updated_at) < ?",
    )
    .run(before);
  return Number(result.changes);
}

export function listRecentJobs(userId: string, limit = 20): JobRow[] {
  return getDb()
    .prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as unknown as JobRow[];
}

/* ------------------------------------------------------------------------ */
/* Job events                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Replaces a finished job's payload with a redacted marker. Used for jobs
 * whose payload is sensitive by nature (e.g. password-reset e-mails carry a
 * one-time link) so the raw value does not linger until retention cleanup.
 */
export function redactJobPayload(jobId: string): void {
  getDb()
    .prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ? AND status IN ('completed','failed','cancelled','expired')")
    .run(JSON.stringify({ redacted: true }), Date.now(), jobId);
}

export function appendJobEvent(input: {
  jobId: string;
  kind: string;
  stage?: string | null;
  payload: unknown;
}): number {
  const db = getDb();
  const rows = db
    .prepare("INSERT INTO job_events (job_id, kind, stage, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .all(input.jobId, input.kind, input.stage ?? null, JSON.stringify(input.payload), Date.now()) as unknown as Array<{
    id: number;
  }>;
  return rows[0]?.id ?? 0;
}

export function listJobEvents(jobId: string, afterId = 0, limit = 500): JobEventRow[] {
  return getDb()
    .prepare("SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
    .all(jobId, afterId, limit) as unknown as JobEventRow[];
}

export function countJobEvents(jobId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS total FROM job_events WHERE job_id = ?").get(jobId) as { total: number })
    .total;
}

/* ------------------------------------------------------------------------ */
/* Worker heartbeats                                                         */
/* ------------------------------------------------------------------------ */

export function upsertWorkerHeartbeat(input: {
  id: string;
  startedAt: number;
  concurrency: number;
  activeJobs: number;
  sandboxAvailable: boolean | null;
  sandboxDetail?: string | null;
  stopping?: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT INTO workers (id, started_at, last_seen_at, concurrency, active_jobs, sandbox_available, sandbox_detail, stopping)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         concurrency = excluded.concurrency,
         active_jobs = excluded.active_jobs,
         sandbox_available = excluded.sandbox_available,
         sandbox_detail = excluded.sandbox_detail,
         stopping = excluded.stopping`,
    )
    .run(
      input.id,
      input.startedAt,
      Date.now(),
      input.concurrency,
      input.activeJobs,
      input.sandboxAvailable === null ? null : input.sandboxAvailable ? 1 : 0,
      input.sandboxDetail ?? null,
      input.stopping ? 1 : 0,
    );
}

export function removeWorker(id: string): void {
  getDb().prepare("DELETE FROM workers WHERE id = ?").run(id);
}

export interface LiveWorkerSummary {
  count: number;
  totalConcurrency: number;
  activeJobs: number;
  sandboxAvailable: boolean | null;
  sandboxDetail: string | null;
  lastSeenAt: number | null;
}

/** Summarizes workers seen within `withinMs`. Never returns worker ids/hostnames. */
export function summarizeLiveWorkers(withinMs: number): LiveWorkerSummary {
  const rows = getDb()
    .prepare("SELECT * FROM workers WHERE last_seen_at >= ? AND stopping = 0")
    .all(Date.now() - withinMs) as unknown as Array<{
    concurrency: number;
    active_jobs: number;
    sandbox_available: number | null;
    sandbox_detail: string | null;
    last_seen_at: number;
  }>;
  let sandboxAvailable: boolean | null = null;
  let sandboxDetail: string | null = null;
  for (const row of rows) {
    if (row.sandbox_available === 1) {
      sandboxAvailable = true;
      sandboxDetail = null;
      break;
    }
    if (row.sandbox_available === 0) {
      sandboxAvailable = false;
      sandboxDetail = row.sandbox_detail;
    }
  }
  return {
    count: rows.length,
    totalConcurrency: rows.reduce((sum, row) => sum + row.concurrency, 0),
    activeJobs: rows.reduce((sum, row) => sum + row.active_jobs, 0),
    sandboxAvailable,
    sandboxDetail,
    lastSeenAt: rows.reduce<number | null>((max, row) => (max === null || row.last_seen_at > max ? row.last_seen_at : max), null),
  };
}

export function deleteStaleWorkers(olderThan: number): number {
  return Number(getDb().prepare("DELETE FROM workers WHERE last_seen_at < ?").run(olderThan).changes);
}
