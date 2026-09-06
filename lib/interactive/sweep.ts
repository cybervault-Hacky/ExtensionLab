import "server-only";
import { getConfig } from "@/lib/config/env";
import type { ContainerHandle, SandboxDriver } from "@/lib/runtime/driver";
import { readdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { getSandboxConfig } from "@/lib/runtime/config";
import { getStorage } from "@/lib/storage/storage";
import { getDb } from "@/lib/db/client";
import {
  appendSessionEvent,
  listAdmittedSessions,
  listExpiredSessions,
  listIdleExpiredSessions,
  listIdleSessions,
  listExpiredSessionArtifacts,
  transitionSession,
} from "@/lib/db/repositories/browser-sessions";
import { getJobById, isTerminalJobStatus } from "@/lib/db/repositories/jobs";
import { logger, recordMetric } from "@/lib/observability/logger";
import { parseRuntimeInfo, destroyInteractiveSession } from "./service";
import { getInteractiveHub } from "./runtime";
import type { InteractiveBrowserSessionRow } from "@/lib/db/schema/types";
import { ControlClient } from "@/lib/runtime/control-client";

/**
 * Interactive session sweeps (Phase 11).
 *
 * Every path that can leave a browser container alive funnels through the
 * worker's periodic INTERACTIVE_BROWSER_CLEANUP job and calls into here:
 * max-lifetime expiry, idle transitions, orphaned starts (worker crash),
 * vanished containers (browser crash) and expired screenshot artifacts.
 * All steps are idempotent and safe to run concurrently.
 */

export interface SweepReport {
  expiredSessions: number;
  idleSessions: number;
  idleExpiredSessions: number;
  failedOrphans: number;
  expiredArtifacts: number;
  cleanupFailures: number;
}

function handleFor(row: InteractiveBrowserSessionRow): ContainerHandle | null {
  const runtime = parseRuntimeInfo(row);
  if (!runtime) return null;
  return {
    containerId: runtime.containerId,
    controlPort: runtime.controlPort,
    controlClient: new ControlClient(runtime.controlPort),
    runnerToken: runtime.runnerToken,
    browserId: row.browser,
  };
}

export async function runInteractiveSweep(driver: SandboxDriver, now = Date.now()): Promise<SweepReport> {
  const config = getConfig().interactiveBrowser;
  const report: SweepReport = {
    expiredSessions: 0,
    idleSessions: 0,
    idleExpiredSessions: 0,
    failedOrphans: 0,
    expiredArtifacts: 0,
    cleanupFailures: 0,
  };

  // 1. READY/ACTIVE sessions with no activity for the idle timeout → IDLE.
  for (const row of listIdleSessions(config.idleTimeoutMs, now)) {
    const updated = transitionSession(row.id, ["READY", "ACTIVE"], "IDLE", {
      stateReason: "No recent activity. The session will expire if it stays idle.",
    });
    if (updated) {
      report.idleSessions++;
      appendSessionEvent(row.id, {
        type: "session_idle",
        level: "warning",
        message: "Session idle: no user activity for a while.",
      });
    }
  }

  // 2. IDLE sessions past the grace window → EXPIRED (container destroyed).
  for (const row of listIdleExpiredSessions(config.idleGraceMs, now)) {
    const stopped = await destroyInteractiveSession(row, driver, {
      from: ["IDLE"],
      to: "EXPIRED",
      stopReason: "idle_timeout",
      stateReason: "The session expired after being idle.",
      events: [{ type: "session_expired", level: "warning", message: "Session expired: idle timeout reached." }],
    });
    if (stopped) {
      report.idleExpiredSessions++;
      recordMetric("interactive.session_expired", 1, { reason: "idle" });
    }
  }

  // 3. Hard lifetime deadline → EXPIRED (never renewable by keepalive).
  for (const row of listExpiredSessions(now)) {
    const stopped = await destroyInteractiveSession(row, driver, {
      from: ["CREATED", "QUEUED", "STARTING", "READY", "ACTIVE", "IDLE", "STOPPING"],
      to: "EXPIRED",
      stopReason: "max_lifetime",
      stateReason: "The session reached its maximum lifetime.",
      events: [{ type: "session_expired", level: "warning", message: "Session expired: maximum lifetime reached." }],
    });
    if (stopped) {
      report.expiredSessions++;
      recordMetric("interactive.session_expired", 1, { reason: "max_lifetime" });
    }
  }

  // 4. Orphans: live sessions whose container vanished (browser/host crash)
  //    or whose start job reached a terminal state without success.
  for (const row of listAdmittedSessions()) {
    const runtime = parseRuntimeInfo(row);
    let orphanReason: string | null = null;

    if (row.status === "STARTING" || row.status === "QUEUED") {
      const job = row.job_id ? getJobById(row.job_id) : null;
      if (job && isTerminalJobStatus(job.status) && job.status !== "completed") {
        orphanReason = job.error_code === "BROWSER_SESSION_LIMIT" ? "start_limit_exhausted" : "start_failed";
      }
    }
    if (!orphanReason && runtime && (runtime.containerId || runtime.containerName)) {
      const handle = handleFor(row);
      if (handle) {
        const running = await driver.isRunning(handle).catch(() => false);
        if (!running && (row.status === "READY" || row.status === "ACTIVE" || row.status === "IDLE" || row.status === "STARTING")) {
          orphanReason = "browser_crash";
          recordMetric("interactive.browser_crashes", 1);
        }
      }
    }
    // STARTING for far too long with no container recorded (worker died mid-start).
    if (!orphanReason && row.status === "STARTING" && !runtime && now - (row.started_at ?? row.created_at) > 5 * 60_000) {
      orphanReason = "start_abandoned";
    }

    if (orphanReason) {
      const stopped = await destroyInteractiveSession(row, driver, {
        from: ["QUEUED", "STARTING", "READY", "ACTIVE", "IDLE", "STOPPING"],
        to: "FAILED",
        stopReason: orphanReason,
        stateReason:
          orphanReason === "browser_crash"
            ? "The browser stopped unexpectedly."
            : "The session could not finish starting and was cleaned up.",
        events: [
          { type: "runtime_error", level: "error", message: `Session failed: ${orphanReason.replace(/_/g, " ")}.` },
          { type: "session_stopped", level: "warning", message: "Session ended after an infrastructure failure." },
        ],
      });
      if (stopped) {
        report.failedOrphans++;
        recordMetric("interactive.session_failures", 1, { reason: orphanReason });
      }
    }
  }

  // 5. Expired screenshot artifacts: blobs first, then rows.
  const storage = getStorage();
  const db = getDb();
  for (const artifact of listExpiredSessionArtifacts(now)) {
    try {
      await storage.delete(artifact.storage_key);
    } catch {
      // Blob may already be gone; deleting the row keeps retention honest.
    }
    db.prepare("DELETE FROM browser_session_artifacts WHERE id = ?").run(artifact.id);
    report.expiredArtifacts++;
  }

  // 6. Leftover temp directories for sessions that no longer exist.
  await cleanupOrphanTempDirs(driver).catch(() => {
    report.cleanupFailures++;
  });

  if (report.cleanupFailures > 0) recordMetric("interactive.cleanup_failures", report.cleanupFailures);
  logger.info("interactive.sweep_completed", { component: "interactive", ...report });
  return report;
}

async function cleanupOrphanTempDirs(_driver: SandboxDriver): Promise<void> {
  // Detach the hub from anything no longer admitted (post-terminal cleanup).
  const admitted = new Set(listAdmittedSessions().map((row) => row.id));
  for (const sessionId of getInteractiveHub().activeSessionIds()) {
    if (!admitted.has(sessionId)) getInteractiveHub().remove(sessionId);
  }

  // Remove ibrowser_* temp directories that no admitted session still uses.
  const root = getSandboxConfig().tempRoot;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const inUse = new Set(
    listAdmittedSessions()
      .map((row) => parseRuntimeInfo(row)?.tempDir ?? "")
      .filter((dir) => dir.length > 0),
  );
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("ibrowser_")) continue;
    const full = join(root, entry.name);
    if (inUse.has(full)) continue;
    const stats = await stat(full).catch(() => null);
    // Young directories may belong to a start in flight; give them room.
    if (stats && now - stats.mtimeMs < 10 * 60_000) continue;
    await rm(full, { recursive: true, force: true });
    recordMetric("interactive.temp_dir_cleaned", 1);
  }
}
