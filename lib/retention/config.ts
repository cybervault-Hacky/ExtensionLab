/**
 * Centralized retention configuration. Every cleanup routine reads its window
 * from here; values are overridable through documented environment variables
 * and expressed in days (except job/session values which follow their own
 * documented units).
 */

const DAY = 24 * 60 * 60 * 1000;

function days(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback * DAY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * DAY : fallback * DAY;
}

export interface RetentionConfig {
  /** Stored extension packages not used by any active run. */
  packageRetentionMs: number;
  /** Test artifacts (screenshots, logs, network summaries). */
  artifactRetentionMs: number;
  /** Password-reset tokens (expired rows are removed after this window). */
  resetTokenRetentionMs: number;
  /** Expired sessions are purged after this window. */
  sessionRetentionMs: number;
  /** Finished jobs (completed/failed/cancelled/expired). */
  jobRetentionMs: number;
  /** Queued jobs older than this that never ran are expired. */
  staleQueuedJobMs: number;
  /** Active test runs with no update for this long are marked as infrastructure errors. */
  staleRunMs: number;
  /** Expired/revoked shares are deleted after this window. */
  shareRetentionMs: number;
}

export function getRetentionConfig(): RetentionConfig {
  return {
    packageRetentionMs: days("PACKAGE_RETENTION_DAYS", 30),
    artifactRetentionMs: days("ARTIFACT_RETENTION_DAYS", 14),
    resetTokenRetentionMs: days("RESET_TOKEN_RETENTION_DAYS", 1),
    sessionRetentionMs: days("SESSION_RETENTION_DAYS", 7),
    jobRetentionMs: days("JOB_RETENTION_DAYS", 14),
    staleQueuedJobMs: days("STALE_JOB_DAYS", 1),
    staleRunMs: Number(process.env.STALE_RUN_MINUTES ?? "") > 0 ? Number(process.env.STALE_RUN_MINUTES) * 60 * 1000 : 30 * 60 * 1000,
    shareRetentionMs: days("SHARE_RETENTION_DAYS", 30),
  };
}
