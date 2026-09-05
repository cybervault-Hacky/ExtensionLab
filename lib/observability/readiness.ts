import "server-only";
import { listAppliedMigrations, pingDb } from "@/lib/db/client";
import { summarizeLiveWorkers } from "@/lib/db/repositories/jobs";
import { getStorage } from "@/lib/storage/storage";
import { getConfig } from "@/lib/config/env";
import { probeSandboxEnvironment } from "@/lib/runtime/availability";
import { isAIEnabled } from "@/lib/ai/provider";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export type CheckStatus = "ok" | "degraded" | "unavailable";

export interface ReadinessReport {
  status: CheckStatus;
  checks: {
    database: { status: CheckStatus; migrationsPending: number };
    storage: { status: CheckStatus; provider: string };
    worker: { status: CheckStatus; mode: string; live: number; activeJobs: number };
    sandbox: { status: CheckStatus; available: boolean; reason?: string };
  };
  capabilities: {
    staticAnalysis: boolean;
    automatedTests: boolean;
    /** Phase 8: an AI provider is configured (never reveals which key/model). */
    aiAssistance: boolean;
  };
  time: string;
}

const WORKER_LIVENESS_MS = 60_000;

/**
 * Readiness: database, storage, worker and sandbox. Reports whether Docker is
 * really available so operators (and the UI) can distinguish "static analysis
 * only" from "full automated testing". Contains no secrets, paths, hostnames
 * or worker ids.
 */
export async function collectReadiness(): Promise<ReadinessReport> {
  const config = getConfig();

  let databaseOk = false;
  let migrationsPending = 0;
  try {
    databaseOk = pingDb();
    if (databaseOk) {
      const applied = new Set(listAppliedMigrations());
      const files = readdirSync(join(process.cwd(), "lib", "db", "migrations")).filter((name) => name.endsWith(".sql"));
      migrationsPending = files.filter((name) => !applied.has(name)).length;
    }
  } catch {
    databaseOk = false;
  }

  let storageOk = false;
  try {
    storageOk = (await getStorage().healthCheck()).ok;
  } catch {
    storageOk = false;
  }

  let workerStatus: CheckStatus = "unavailable";
  let live = 0;
  let activeJobs = 0;
  let workerSandbox: boolean | null = null;
  let workerSandboxDetail: string | null = null;
  if (databaseOk) {
    try {
      const summary = summarizeLiveWorkers(WORKER_LIVENESS_MS);
      live = summary.count;
      activeJobs = summary.activeJobs;
      workerSandbox = summary.sandboxAvailable;
      workerSandboxDetail = summary.sandboxDetail;
      workerStatus = live > 0 ? "ok" : config.jobs.workerMode === "embedded" ? "degraded" : "unavailable";
    } catch {
      workerStatus = "unavailable";
    }
  }

  // Sandbox availability: prefer what a live worker reports (it is the process
  // that actually runs Docker); fall back to a local probe.
  let sandboxAvailable = false;
  let sandboxReason: string | undefined;
  if (workerSandbox !== null && live > 0) {
    sandboxAvailable = workerSandbox;
    sandboxReason = workerSandbox ? undefined : workerSandboxDetail ?? "unavailable";
  } else {
    const probe = await probeSandboxEnvironment();
    sandboxAvailable = probe.available && workerStatus !== "unavailable";
    sandboxReason = probe.available ? (workerStatus === "unavailable" ? "worker_unavailable" : undefined) : probe.reason;
  }

  const checks: ReadinessReport["checks"] = {
    database: { status: databaseOk ? (migrationsPending > 0 ? "degraded" : "ok") : "unavailable", migrationsPending },
    storage: { status: storageOk ? "ok" : "unavailable", provider: config.storage.provider },
    worker: { status: workerStatus, mode: config.jobs.workerMode, live, activeJobs },
    sandbox: { status: sandboxAvailable ? "ok" : "unavailable", available: sandboxAvailable, reason: sandboxReason },
  };

  const core = [checks.database.status, checks.storage.status];
  const status: CheckStatus = core.includes("unavailable")
    ? "unavailable"
    : core.includes("degraded") || checks.worker.status !== "ok" || !sandboxAvailable
      ? "degraded"
      : "ok";

  return {
    status,
    checks,
    capabilities: {
      staticAnalysis: databaseOk,
      automatedTests: databaseOk && storageOk && sandboxAvailable && workerStatus !== "unavailable",
      aiAssistance: databaseOk && isAIEnabled(),
    },
    time: new Date().toISOString(),
  };
}
