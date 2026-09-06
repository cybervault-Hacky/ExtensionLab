import "server-only";
import { getDb, transaction } from "../client";
import { generateDbId } from "../ids";
import type { BrowserSessionArtifactRow, InteractiveBrowserSessionRow, InteractiveSessionEventRow } from "../schema/types";

/**
 * Phase 11 interactive browser session repository.
 *
 * State transitions are expressed as conditional UPDATEs (compare-and-set on
 * the expected status) so that the web process, the worker and the cleanup
 * sweeps can never both win the same transition — the same discipline the
 * Phase 6 job repository uses.
 */

export const INTERACTIVE_SESSION_STATUSES = [
  "CREATED",
  "QUEUED",
  "STARTING",
  "READY",
  "ACTIVE",
  "IDLE",
  "STOPPING",
  "STOPPED",
  "EXPIRED",
  "FAILED",
] as const;
export type InteractiveSessionStatus = (typeof INTERACTIVE_SESSION_STATUSES)[number];

export const TERMINAL_SESSION_STATUSES: readonly InteractiveSessionStatus[] = ["STOPPED", "EXPIRED", "FAILED"];
export const LIVE_SESSION_STATUSES: readonly InteractiveSessionStatus[] = [
  "STARTING",
  "READY",
  "ACTIVE",
  "IDLE",
  "STOPPING",
];
export const ADMITTED_SESSION_STATUSES: readonly InteractiveSessionStatus[] = [
  "QUEUED",
  "STARTING",
  "READY",
  "ACTIVE",
  "IDLE",
  "STOPPING",
];

/**
 * Statuses that hold a runtime slot (a container exists or is being created).
 * Concurrency caps count only these: QUEUED sessions hold no container, and
 * counting them would let an oversubscribed queue deadlock against its own
 * capacity limit (every start would see the other queued sessions as load).
 */
export const RUNTIME_SLOT_STATUSES: readonly InteractiveSessionStatus[] = [
  "STARTING",
  "READY",
  "ACTIVE",
  "IDLE",
  "STOPPING",
];
/** Statuses that accept browser commands (navigation, input, popup, viewport). */
export const COMMANDABLE_SESSION_STATUSES: readonly InteractiveSessionStatus[] = ["READY", "ACTIVE", "IDLE"];

export function isInteractiveSessionStatus(value: string): value is InteractiveSessionStatus {
  return (INTERACTIVE_SESSION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalSessionStatus(status: string): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}

export interface SessionEventInput {
  type: string;
  level?: "info" | "warning" | "error";
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/** Maximum structured session events retained per session (bounded storage). */
export const MAX_SESSION_EVENTS = 120;

export function insertSession(id: string, input: {
  userId: string;
  organizationId: string | null;
  extensionId: string | null;
  packageId: string;
  packageVersion: string | null;
  packageSha256: string;
  browser: string;
  viewportWidth: number;
  viewportHeight: number;
  initialUrl: string | null;
  extensionInfoJson: string;
  quotaReservationId: string | null;
  requestId: string | null;
  expiresAt: number;
}): InteractiveBrowserSessionRow {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO interactive_browser_sessions
      (id, user_id, organization_id, extension_id, package_id, package_version, package_sha256,
       browser, browser_version, status, state_reason, initial_url, current_url,
       viewport_width, viewport_height, popup_open, artifact_count, extension_info_json,
       runtime_json, quota_reservation_id, job_id, request_id,
       created_at, updated_at, started_at, ready_at, last_activity_at, expires_at, stopped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'CREATED', 'Session created.', ?, NULL,
             ?, ?, 0, 0, ?, '{}', ?, NULL, ?,
             ?, ?, NULL, NULL, ?, ?, NULL)`,
  ).run(
    id,
    input.userId,
    input.organizationId,
    input.extensionId,
    input.packageId,
    input.packageVersion,
    input.packageSha256,
    input.browser,
    input.initialUrl,
    input.viewportWidth,
    input.viewportHeight,
    input.extensionInfoJson,
    input.quotaReservationId,
    input.requestId,
    now,
    now,
    now,
    input.expiresAt,
  );
  return getSessionById(id)!;
}

export function getSessionById(id: string): InteractiveBrowserSessionRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM interactive_browser_sessions WHERE id = ?").get(id) as
      | InteractiveBrowserSessionRow
      | undefined) ?? null
  );
}

/** Owner-scoped lookup. Cross-tenant callers receive null (→ 404). */
export function getOwnedSession(userId: string, id: string): InteractiveBrowserSessionRow | null {
  const row = getSessionById(id);
  return row && row.user_id === userId ? row : null;
}

export function listSessionsForUser(userId: string, limit = 20): InteractiveBrowserSessionRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM interactive_browser_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as unknown as InteractiveBrowserSessionRow[];
}

export function listSessionsForPackage(packageId: string, limit = 20): InteractiveBrowserSessionRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM interactive_browser_sessions WHERE package_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(packageId, limit) as unknown as InteractiveBrowserSessionRow[];
}

export function countSessionsByStatus(): Record<string, number> {
  const db = getDb();
  const rows = db.prepare("SELECT status, COUNT(*) AS total FROM interactive_browser_sessions GROUP BY status").all() as Array<{
    status: string;
    total: number;
  }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.total;
  return out;
}

export function countAdmittedSessions(): { global: number; perUser: Map<string, number>; perOrg: Map<string, number> } {
  const db = getDb();
  const placeholders = ADMITTED_SESSION_STATUSES.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT user_id, organization_id FROM interactive_browser_sessions WHERE status IN (${placeholders})`)
    .all(...ADMITTED_SESSION_STATUSES) as Array<{ user_id: string; organization_id: string | null }>;
  const perUser = new Map<string, number>();
  const perOrg = new Map<string, number>();
  for (const row of rows) {
    perUser.set(row.user_id, (perUser.get(row.user_id) ?? 0) + 1);
    if (row.organization_id) perOrg.set(row.organization_id, (perOrg.get(row.organization_id) ?? 0) + 1);
  }
  return { global: rows.length, perUser, perOrg };
}

/**
 * Atomically claims a start slot and moves QUEUED → STARTING.
 *
 * Returns the updated row when a slot was claimed; `null` when the session is
 * no longer queued, and `"capacity"` when a global/per-user/per-organization
 * limit is already exhausted. Runs inside BEGIN IMMEDIATE so parallel start
 * jobs cannot oversubscribe the deployment.
 */
export function claimStartSlot(input: {
  sessionId: string;
  globalLimit: number;
  userLimit: number;
  orgLimit: number;
}): InteractiveBrowserSessionRow | "capacity" | null {
  const db = getDb();
  return transaction(db, () => {
    const row = getSessionById(input.sessionId);
    if (!row || row.status !== "QUEUED") return null;
    const placeholders = RUNTIME_SLOT_STATUSES.map(() => "?").join(",");
    const global = (
      db
        .prepare(`SELECT COUNT(*) AS total FROM interactive_browser_sessions WHERE status IN (${placeholders}) AND id != ?`)
        .get(...RUNTIME_SLOT_STATUSES, row.id) as { total: number }
    ).total;
    if (global >= input.globalLimit) return "capacity";
    const userCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS total FROM interactive_browser_sessions WHERE status IN (${placeholders}) AND user_id = ? AND id != ?`,
        )
        .get(...RUNTIME_SLOT_STATUSES, row.user_id, row.id) as { total: number }
    ).total;
    if (userCount >= input.userLimit) return "capacity";
    if (row.organization_id) {
      const orgCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS total FROM interactive_browser_sessions WHERE status IN (${placeholders}) AND organization_id = ? AND id != ?`,
          )
          .get(...RUNTIME_SLOT_STATUSES, row.organization_id, row.id) as { total: number }
      ).total;
      if (orgCount >= input.orgLimit) return "capacity";
    }
    const now = Date.now();
    db.prepare(
      "UPDATE interactive_browser_sessions SET status = 'STARTING', state_reason = 'Starting disposable browser.', started_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'",
    ).run(now, now, row.id);
    return getSessionById(row.id);
  });
}

/** Conditional status transition; returns the fresh row or null when lost. */
export function transitionSession(
  id: string,
  from: readonly string[],
  to: InteractiveSessionStatus,
  fields: {
    stateReason?: string;
    stopReason?: string | null;
    browserVersion?: string | null;
    currentUrl?: string | null;
    runtimeJson?: string;
    jobId?: string | null;
    popupOpen?: boolean;
    popupWidth?: number | null;
    popupHeight?: number | null;
    artifactCount?: number;
    viewportWidth?: number;
    viewportHeight?: number;
    stoppedAt?: number | null;
    readyAt?: number | null;
    touchActivity?: boolean;
  } = {},
): InteractiveBrowserSessionRow | null {
  const db = getDb();
  const now = Date.now();
  const sets: string[] = ["status = ?", "updated_at = ?"];
  const values: Array<string | number | null> = [to, now];
  if (fields.stateReason !== undefined) {
    sets.push("state_reason = ?");
    values.push(fields.stateReason);
  }
  if (fields.stopReason !== undefined) {
    sets.push("stop_reason = ?");
    values.push(fields.stopReason);
  }
  if (fields.browserVersion !== undefined) {
    sets.push("browser_version = ?");
    values.push(fields.browserVersion);
  }
  if (fields.currentUrl !== undefined) {
    sets.push("current_url = ?");
    values.push(fields.currentUrl);
  }
  if (fields.runtimeJson !== undefined) {
    sets.push("runtime_json = ?");
    values.push(fields.runtimeJson);
  }
  if (fields.jobId !== undefined) {
    sets.push("job_id = ?");
    values.push(fields.jobId);
  }
  if (fields.popupOpen !== undefined) {
    sets.push("popup_open = ?");
    values.push(fields.popupOpen ? 1 : 0);
  }
  if (fields.popupWidth !== undefined) {
    sets.push("popup_width = ?");
    values.push(fields.popupWidth);
  }
  if (fields.popupHeight !== undefined) {
    sets.push("popup_height = ?");
    values.push(fields.popupHeight);
  }
  if (fields.artifactCount !== undefined) {
    sets.push("artifact_count = ?");
    values.push(fields.artifactCount);
  }
  if (fields.viewportWidth !== undefined) {
    sets.push("viewport_width = ?");
    values.push(fields.viewportWidth);
  }
  if (fields.viewportHeight !== undefined) {
    sets.push("viewport_height = ?");
    values.push(fields.viewportHeight);
  }
  if (fields.stoppedAt !== undefined) {
    sets.push("stopped_at = ?");
    values.push(fields.stoppedAt);
  }
  if (fields.readyAt !== undefined) {
    sets.push("ready_at = ?");
    values.push(fields.readyAt);
  }
  if (fields.touchActivity) {
    sets.push("last_activity_at = ?");
    values.push(now);
  }
  const placeholders = from.map(() => "?").join(",");
  values.push(id, ...from);
  const result = db
    .prepare(`UPDATE interactive_browser_sessions SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
    .run(...values);
  if (result.changes === 0) return null;
  return getSessionById(id);
}

/** Marks activity (input/navigation/keepalive) and wakes an IDLE session. */
export function touchSessionActivity(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    "UPDATE interactive_browser_sessions SET last_activity_at = ?, updated_at = ?, status = CASE WHEN status = 'IDLE' THEN 'ACTIVE' ELSE status END WHERE id = ?",
  ).run(now, now, id);
}

export function listAdmittedSessions(): InteractiveBrowserSessionRow[] {
  const db = getDb();
  const placeholders = ADMITTED_SESSION_STATUSES.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM interactive_browser_sessions WHERE status IN (${placeholders})`)
    .all(...ADMITTED_SESSION_STATUSES) as unknown as InteractiveBrowserSessionRow[];
}

/** Sessions whose hard lifetime deadline has passed and are not terminal yet. */
export function listExpiredSessions(now = Date.now()): InteractiveBrowserSessionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM interactive_browser_sessions WHERE expires_at <= ? AND status NOT IN ('STOPPED','EXPIRED','FAILED')`,
    )
    .all(now) as unknown as InteractiveBrowserSessionRow[];
}

/** Sessions with no activity for `idleMs` (READY/ACTIVE only → candidates for IDLE). */
export function listIdleSessions(idleMs: number, now = Date.now()): InteractiveBrowserSessionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM interactive_browser_sessions
       WHERE status IN ('READY','ACTIVE') AND last_activity_at IS NOT NULL AND last_activity_at <= ?`,
    )
    .all(now - idleMs) as unknown as InteractiveBrowserSessionRow[];
}

/**
 * IDLE sessions past their grace window → candidates for EXPIRED.
 * Grace runs from the moment the session became IDLE (the IDLE transition
 * stamps updated_at), NOT from the last activity — otherwise a single sweep
 * would expire sessions the instant they go idle whenever grace < idle timeout.
 */
export function listIdleExpiredSessions(graceMs: number, now = Date.now()): InteractiveBrowserSessionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM interactive_browser_sessions WHERE status = 'IDLE' AND updated_at <= ?`,
    )
    .all(now - graceMs) as unknown as InteractiveBrowserSessionRow[];
}

export function deleteSessionsForUser(userId: string): number {
  const db = getDb();
  return Number(db.prepare("DELETE FROM interactive_browser_sessions WHERE user_id = ?").run(userId).changes);
}

// ---------------------------------------------------------------------------
// Structured session events (bounded)
// ---------------------------------------------------------------------------

export function appendSessionEvent(sessionId: string, input: SessionEventInput): InteractiveSessionEventRow | null {
  const db = getDb();
  const row = getSessionById(sessionId);
  if (!row) return null;
  const now = Date.now();
  const seq = (
    db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM interactive_session_events WHERE session_id = ?").get(
      sessionId,
    ) as { next: number }
  ).next;
  const id = generateDbId("ise");
  db.prepare(
    `INSERT INTO interactive_session_events (id, session_id, seq, type, level, message, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    seq,
    input.type,
    input.level ?? "info",
    input.message.slice(0, 2000),
    JSON.stringify(input.metadata ?? {}),
    now,
  );
  // Bound the stored history: keep only the most recent MAX_SESSION_EVENTS rows.
  db.prepare(
    `DELETE FROM interactive_session_events WHERE session_id = ? AND seq <= (
       SELECT COALESCE(MAX(seq), 0) FROM interactive_session_events WHERE session_id = ?
     ) - ?`,
  ).run(sessionId, sessionId, MAX_SESSION_EVENTS);
  return listSessionEventById(id);
}

function listSessionEventById(id: string): InteractiveSessionEventRow | null {
  return (getDb().prepare("SELECT * FROM interactive_session_events WHERE id = ?").get(id) as
    | InteractiveSessionEventRow
    | undefined) ?? null;
}

export function listSessionEvents(sessionId: string, afterSeq = 0, limit = MAX_SESSION_EVENTS): InteractiveSessionEventRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM interactive_session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    )
    .all(sessionId, afterSeq, limit) as unknown as InteractiveSessionEventRow[];
}

// ---------------------------------------------------------------------------
// Session screenshot artifacts
// ---------------------------------------------------------------------------

export function createSessionArtifactRecord(input: {
  sessionId: string;
  userId: string;
  storageKey: string;
  size: number;
  sha256: string;
  contentType: string;
  label?: string | null;
  packageVersion: string | null;
  packageSha256: string | null;
  browser: string | null;
  browserVersion: string | null;
  expiresAt: number;
}): BrowserSessionArtifactRow {
  const db = getDb();
  const id = generateDbId("bart");
  const now = Date.now();
  db.prepare(
    `INSERT INTO browser_session_artifacts
      (id, session_id, user_id, type, storage_key, size, sha256, content_type, label,
       package_version, package_sha256, browser, browser_version, created_at, expires_at)
     VALUES (?, ?, ?, 'screenshot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.userId,
    input.storageKey,
    input.size,
    input.sha256,
    input.contentType,
    input.label ?? null,
    input.packageVersion,
    input.packageSha256,
    input.browser,
    input.browserVersion,
    now,
    input.expiresAt,
  );
  return getSessionArtifactById(id)!;
}

export function getSessionArtifactById(id: string): BrowserSessionArtifactRow | null {
  return (getDb().prepare("SELECT * FROM browser_session_artifacts WHERE id = ?").get(id) as
    | BrowserSessionArtifactRow
    | undefined) ?? null;
}

export function listSessionArtifacts(sessionId: string, limit = 50): BrowserSessionArtifactRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM browser_session_artifacts WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(sessionId, limit) as unknown as BrowserSessionArtifactRow[];
}

export function deleteSessionArtifactsForSession(sessionId: string): BrowserSessionArtifactRow[] {
  const db = getDb();
  const rows = listSessionArtifacts(sessionId, 1000);
  db.prepare("DELETE FROM browser_session_artifacts WHERE session_id = ?").run(sessionId);
  return rows;
}

export function listExpiredSessionArtifacts(now = Date.now()): BrowserSessionArtifactRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM browser_session_artifacts WHERE expires_at <= ?")
    .all(now) as unknown as BrowserSessionArtifactRow[];
}

/** Phase 11 admin: recently finished sessions (failure forensics). */
export function listRecentlyFinishedSessions(limit = 25): InteractiveBrowserSessionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM interactive_browser_sessions WHERE status IN ('STOPPED','EXPIRED','FAILED') ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as InteractiveBrowserSessionRow[];
}
