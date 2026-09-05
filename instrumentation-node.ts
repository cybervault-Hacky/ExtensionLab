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

  if (config.jobs.workerMode === "embedded") {
    const { ensureEmbeddedWorker } = await import("@/lib/jobs/runtime");
    ensureEmbeddedWorker();
  }
}
