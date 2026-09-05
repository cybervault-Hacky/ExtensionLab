import "server-only";
import { getConfig } from "@/lib/config/env";
import { getBrowserConcurrency, getMaxConcurrentRuns } from "@/lib/billing/entitlements";
import { getBrowserRegistryConfig } from "@/lib/browsers/registry";
import { getSandboxManager } from "@/lib/runtime/sandbox-manager-instance";
import { probeSandboxEnvironment } from "@/lib/runtime/availability";
import { logger } from "@/lib/observability/logger";
import { JobWorker, type WorkerOptions } from "./worker";
import { Scheduler } from "./scheduler";
import { createAutomatedTestHandler } from "./handlers/automated-test";
import { createCleanupHandler } from "./handlers/cleanup";
import { createWebhookDeliveryHandler } from "./handlers/webhook-delivery";
import { createOrgExportHandler } from "./handlers/org-export";
import { getOrganizationEntitlements } from "@/lib/organizations/entitlements";
import { createEmailHandler } from "./handlers/email";

/**
 * Builds a fully wired worker: Docker-backed SandboxManager, Phase 4 test
 * engine, email delivery and cleanup handlers.
 */
export function createWorker(options: WorkerOptions = {}): JobWorker {
  const config = getConfig();
  const sandboxManager = getSandboxManager();
  const worker = new JobWorker({
    sandboxProbe: async () => {
      const probe = await probeSandboxEnvironment();
      return { available: probe.available, detail: probe.available ? undefined : probe.reason };
    },
    // Paid plans may run more jobs at once; SANDBOX_USER_CONCURRENCY is the
    // floor. Phase 9: browser executions (matrix children) are admitted under
    // the plan's browser concurrency when it is higher, clamped by the
    // deployment-wide MAX_MATRIX_CONCURRENCY ceiling.
    userConcurrencyFor: (userId) =>
      Math.max(
        getMaxConcurrentRuns(userId),
        Math.min(getBrowserConcurrency(userId), getBrowserRegistryConfig().limits.maxMatrixConcurrency),
      ),
    // Phase 10: organization fairness — one organization can never monopolize
    // the worker fleet while others wait.
    orgConcurrencyFor: (organizationId) => getOrganizationEntitlements(organizationId).orgMaxConcurrency,
    ...options,
  });
  worker
    .register(createAutomatedTestHandler({ sandboxManager, maxConcurrentRuns: config.sandbox.maxConcurrency }))
    .register(createEmailHandler())
    .register(createCleanupHandler())
    .register(createWebhookDeliveryHandler())
    .register(createOrgExportHandler());
  return worker;
}

declare global {
  // eslint-disable-next-line no-var
  var __extensionlabEmbeddedWorker: { worker: JobWorker; scheduler: Scheduler } | undefined;
}

/**
 * Embedded mode (development / single-process deployments): the web process
 * runs a worker loop in-process. Production deployments run `npm run worker`
 * as a separate service (WORKER_MODE=external) and this is a no-op.
 */
export function ensureEmbeddedWorker(): JobWorker | null {
  const config = getConfig();
  if (config.jobs.workerMode !== "embedded") return null;
  if (globalThis.__extensionlabEmbeddedWorker) return globalThis.__extensionlabEmbeddedWorker.worker;
  const worker = createWorker({ workerId: `${config.jobs.workerId}-embedded` });
  const scheduler = new Scheduler();
  worker.start();
  scheduler.start();
  globalThis.__extensionlabEmbeddedWorker = { worker, scheduler };
  logger.info("worker.embedded_started", { component: "worker" });
  const shutdown = () => {
    scheduler.stop();
    void worker.stop();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return worker;
}

/** Wakes the embedded worker after an enqueue (no-op in external mode). */
export function notifyEmbeddedWorker(): void {
  globalThis.__extensionlabEmbeddedWorker?.worker.notify();
}
