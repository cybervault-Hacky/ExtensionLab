import { getConfig, describeConfig } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";

/**
 * Node runtime bootstrap:
 * - Validates configuration early (fails fast in production when mandatory
 *   secrets are missing).
 * - Starts the embedded job worker in development / single-process mode so
 *   queued test runs execute without a separate `npm run worker` process.
 *   In production (WORKER_MODE=external) this is a no-op and the dedicated
 *   worker service owns all sandbox execution.
 */
export async function registerNode(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const config = getConfig();
  logger.info("web.startup", { component: "web", ...describeConfig(config) });

  // Phase 13: eagerly initialize async infrastructure providers (S3 storage,
  // Redis coordination) so the first request never races their construction,
  // and so a misconfigured provider fails loudly at boot instead of per-request.
  try {
    const { ensureStorageInitialized } = await import("@/lib/storage/storage");
    await ensureStorageInitialized();
  } catch (error) {
    logger.error("web.storage_init_failed", { component: "web", detail: error instanceof Error ? error.message : String(error) });
    if (config.appEnv === "production") throw error;
  }
  try {
    const { getCoordinationStore } = await import("@/lib/coordination");
    await getCoordinationStore();
  } catch (error) {
    logger.error("web.coordination_init_failed", { component: "web", detail: error instanceof Error ? error.message : String(error) });
    if (config.appEnv === "production") throw error;
  }

  if (config.jobs.workerMode === "embedded") {
    const { ensureEmbeddedWorker } = await import("@/lib/jobs/runtime");
    ensureEmbeddedWorker();
  }
}
