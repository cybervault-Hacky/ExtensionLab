/**
 * On-demand retention cleanup: `npm run cleanup`.
 *
 * Runs the same idempotent steps as the scheduled ARTIFACT_CLEANUP job and
 * prints the counters. Safe to run while web and worker are up.
 */
import { closeDb, getDb } from "@/lib/db/client";
import { logger } from "@/lib/observability/logger";
import { runCleanup } from "@/lib/jobs/cleanup";

async function main(): Promise<void> {
  getDb();
  const scope = process.argv[2] as "all" | "artifacts" | "packages" | "auth" | "jobs" | "billing" | "ai" | undefined;
  const report = await runCleanup(scope ? { scope } : {});
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    logger.error("cleanup.failed", { errorCode: "INTERNAL", detail: error instanceof Error ? error.name : "unknown" });
    process.exitCode = 1;
  })
  .finally(() => closeDb());
