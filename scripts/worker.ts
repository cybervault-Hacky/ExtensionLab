/**
 * Background worker entrypoint: `npm run worker`.
 *
 * Runs migrations check, wires handlers (automated tests via Docker sandbox,
 * email delivery, scheduled cleanup) and shuts down gracefully on
 * SIGTERM/SIGINT: stop claiming, cancel or finish active jobs, destroy
 * sandboxes, flush state, close the database.
 */
import { getConfig, describeConfig } from "@/lib/config/env";
import { closeDb, getDb, listAppliedMigrations } from "@/lib/db/client";
import { logger } from "@/lib/observability/logger";
import { createWorker } from "@/lib/jobs/runtime";
import { Scheduler } from "@/lib/jobs/scheduler";
import { probeSandboxEnvironment } from "@/lib/runtime/availability";

async function main(): Promise<void> {
  const config = getConfig();
  getDb();
  const migrations = listAppliedMigrations();
  logger.info("worker.boot", { component: "worker", migrations: migrations.length, ...describeConfig(config) });

  // Phase 13: async infrastructure providers come up before jobs are claimed.
  const { ensureStorageInitialized } = await import("@/lib/storage/storage");
  await ensureStorageInitialized();
  const { getCoordinationStore } = await import("@/lib/coordination");
  await getCoordinationStore();

  const sandbox = await probeSandboxEnvironment(true);
  if (!sandbox.available) {
    logger.warn("worker.sandbox_unavailable", { component: "worker", reason: sandbox.reason });
  }

  const worker = createWorker();
  const scheduler = new Scheduler();
  worker.start();
  scheduler.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("worker.signal", { component: "worker", signal });
    scheduler.stop();
    const timer = setTimeout(() => {
      logger.error("worker.shutdown_timeout", { component: "worker" });
      process.exit(1);
    }, config.jobs.shutdownGraceMs + 10_000);
    timer.unref();
    try {
      await worker.stop();
    } finally {
      closeDb();
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error("worker.unhandled_rejection", { component: "worker", detail: reason instanceof Error ? reason.name : "unknown" });
  });
}

main().catch((error) => {
  logger.error("worker.fatal", { component: "worker", detail: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
