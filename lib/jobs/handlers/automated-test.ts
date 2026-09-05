import "server-only";
import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getSandboxConfig } from "@/lib/runtime/config";
import { probeSandboxEnvironment, type SandboxProbeResult } from "@/lib/runtime/availability";
import { getBrowserRuntimesHealth } from "@/lib/browsers/availability";
import { getBrowserRegistryConfig } from "@/lib/browsers/registry";
import { isBrowserId, type BrowserId } from "@/lib/browsers/types";
import { extractZipToDirectory } from "@/lib/runtime/extract";
import type { SandboxManager } from "@/lib/runtime/sandbox-manager";
import { TestRunManager } from "@/lib/testing/test-runner";
import { createTestRunPersistence } from "@/lib/testing/persistence";
import { discoverTests } from "@/lib/testing/registry";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { ExtensionLabError } from "@/lib/extension/errors";
import { readPackageBytes } from "@/lib/packages/service";
import { persistRunArtifacts } from "@/lib/artifacts/service";
import {
  finalizeTestRunWithoutResults,
  getTestRunById,
  requeueTestRunForRetry,
  updateTestRunBrowser,
  updateTestRunStage,
} from "@/lib/db/repositories/test-runs";
import { releaseReservationForResource } from "@/lib/db/repositories/quota";
import { noteMatrixChildFinished } from "@/lib/testing/matrix-service";
import { dispatchOrganizationEvent } from "@/lib/webhooks/dispatch";
import { AppError, classifyError, toErrorCode } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { generateSessionToken } from "@/lib/runtime/ids";
import type { JobContext, JobHandler } from "../types";

/**
 * AUTOMATED_TEST handler.
 *
 * Flow: stored package → extract to a private temp dir → TestRunManager
 * (Phase 4 engine) → SandboxManager (Phase 3 Docker isolation) → results →
 * artifacts → persisted run. The handler never executes extension code; it
 * only feeds the package into a disposable container.
 */
export interface AutomatedTestHandlerDeps {
  sandboxManager: SandboxManager;
  maxConcurrentRuns: number;
  /** Pre-flight Docker probe; injectable for tests. Defaults to the real probe. */
  sandboxProbe?: () => Promise<SandboxProbeResult>;
}

export function createAutomatedTestHandler(deps: AutomatedTestHandlerDeps): JobHandler<"AUTOMATED_TEST"> {
  const activeRuns = new Map<string, { manager: TestRunManager; runId: string; token: string }>();

  return {
    type: "AUTOMATED_TEST",

    async handle(context: JobContext<"AUTOMATED_TEST">): Promise<Record<string, unknown>> {
      const { payload, job } = context;
      const runId = payload.runId;
      const row = getTestRunById(runId);
      if (!row) throw new AppError("NOT_FOUND", { message: "Test run not found." });
      if (["completed", "failed", "timeout", "destroyed"].includes(row.status)) {
        // Idempotency: a retried/duplicated job whose run already finished does
        // nothing — but it must not report success for a run that failed.
        if (row.status === "failed" && row.outcome === "INFRASTRUCTURE_ERROR") {
          throw new AppError(toErrorCode(row.error_code ?? "SANDBOX_UNAVAILABLE"), { retryable: false, message: row.reason ?? undefined });
        }
        return { runId, status: row.status, outcome: row.outcome ?? null, skipped: true };
      }
      if (context.isCancelled()) {
        finalizeCancelled(runId, "Cancelled before the sandbox started.");
        return { runId, status: "destroyed", outcome: "CANCELLED" };
      }

      const sessionPath = join(getSandboxConfig().tempRoot, `job_${randomBytes(8).toString("hex")}`);
      let manager: TestRunManager | null = null;
      let token = "";
      try {
        updateTestRunStage(runId, { status: "preparing", stage: "Preparing" });
        context.emit("stage", { type: "stage", stage: "Preparing", timestamp: Date.now() }, "Preparing");

        // Pre-flight: never pretend to run tests when Docker is not there.
        // A missing/disabled Docker is permanent for this host (no retry); an
        // unreachable daemon or a missing image may recover (retry with backoff).
        const probe = await (deps.sandboxProbe ?? probeSandboxEnvironment)();
        if (!probe.available) {
          const permanent = probe.reason === "disabled" || probe.reason === "docker_missing";
          throw new AppError("SANDBOX_UNAVAILABLE", { retryable: !permanent });
        }

        // Phase 9: verify the specific browser runtime image before creating a
        // doomed container. Missing images are permanent for this host (no
        // retry); an unreachable daemon stays retryable via the probe above.
        const browserId: BrowserId = isBrowserId(payload.browserId) ? payload.browserId : "chromium";
        if (browserId !== "chromium") {
          const browserHealth = await getBrowserRuntimesHealth();
          if (!browserHealth[browserId]?.available) {
            const reason = browserHealth[browserId]?.reason ?? "image_missing";
            throw new AppError("BROWSER_RUNTIME_UNAVAILABLE", {
              retryable: reason === "docker_unavailable",
              message: `The ${browserId} runtime image is not available on this deployment.`,
            });
          }
        }

        const { bytes, row: pkg } = await readPackageBytes(payload.packageId);
        if (pkg.user_id !== row.user_id) throw new AppError("FORBIDDEN");

        let analysis;
        try {
          analysis = await analyzeZipBytes(bytes, pkg.original_name ?? "package.zip");
        } catch (error) {
          throw new AppError("INVALID_EXTENSION", {
            message: error instanceof ExtensionLabError ? error.message : undefined,
            cause: error,
          });
        }
        const discovered = discoverTests(analysis).tests;
        const wanted = new Set(payload.testIds ?? []);
        const tests = wanted.size > 0 ? discovered.filter((test) => wanted.has(test.id)) : discovered;

        await mkdir(sessionPath, { recursive: true, mode: 0o700 });
        try {
          await extractZipToDirectory(bytes, sessionPath);
        } catch (error) {
          throw new AppError("INVALID_EXTENSION", {
            message: error instanceof ExtensionLabError ? error.message : undefined,
            cause: error,
          });
        }
        context.heartbeat();
        // Last check before the irreversible part: consult the database directly.
        if (context.isCancelled(true)) {
          finalizeCancelled(runId, "Cancelled before the sandbox started.");
          return { runId, status: "destroyed", outcome: "CANCELLED" };
        }

        const attemptsRemain = job.attempts < job.max_attempts;
        manager = new TestRunManager(
          deps.sandboxManager,
          createTestRunPersistence({
            jobId: job.id,
            useReservations: true,
            // Only transient sandbox failures are retried, and only while the
            // job still has attempts left; the run is then re-queued instead of
            // being finalized as an infrastructure error.
            shouldRetry: (errorCode) => attemptsRemain && !context.isCancelled() && isTransientRunError(errorCode),
          }),
          { maxConcurrentRuns: deps.maxConcurrentRuns },
        );
        token = generateSessionToken();
        await manager.create({
          sourcePath: sessionPath,
          analysis,
          tests,
          testUrl: payload.testUrl,
          clientIp: "worker",
          runId,
          token,
          trusted: true,
          browser: browserId,
        });
        activeRuns.set(job.id, { manager, runId, token });

        const heartbeat = setInterval(() => {
          context.heartbeat();
          if (context.isCancelled()) {
            void manager?.stop(runId, token).catch(() => undefined);
          }
        }, 2000);
        heartbeat.unref?.();

        let info;
        try {
          info = await manager.execute(runId, token);
        } finally {
          clearInterval(heartbeat);
        }

        const snapshot = manager.getSnapshot(runId, token);
        if (info.state === "completed" || info.state === "timeout") {
          try {
            const artifacts = await persistRunArtifacts({
              runId,
              userId: row.user_id,
              screenshots: snapshot.screenshots ?? [],
              runtimeEvents: snapshot.runtimeEvents ?? [],
              network: snapshot.network ?? [],
              ...(payload.matrixRunId ? { maxScreenshots: getBrowserRegistryConfig().limits.maxMatrixArtifacts } : {}),
            });
            logger.info("test_run.artifacts", { runId, jobId: job.id, count: artifacts.length });
          } catch (error) {
            logger.warn("test_run.artifacts_failed", { runId, jobId: job.id, errorCode: classifyError(error).code });
          }
        }
        recordMetric("job.automated_test", 1, { state: info.state, browserId });
        if (row.organization_id) {
          const passed = row.outcome === "PASSED" || row.outcome === "WARNING";
          dispatchOrganizationEvent(
            row.organization_id,
            passed ? "test_run.completed" : "test_run.failed",
            { runId, organizationId: row.organization_id, outcome: row.outcome ?? info.state, score: row.score },
          );
        }

        // Phase 9: record the detected browser version and, for matrix
        // children, hand the evidence to the matrix aggregator (idempotent).
        if (snapshot.browserVersion) {
          try {
            updateTestRunBrowser(runId, snapshot.browserVersion);
          } catch {
            // Best-effort reproducibility metadata.
          }
        }
        if (payload.matrixRunId) {
          try {
            noteMatrixChildFinished(runId, {
              consoleEvents: snapshot.runtimeEvents ?? [],
              network: snapshot.network ?? [],
              screenshotCount: (snapshot.screenshots ?? []).length,
            });
          } catch (error) {
            logger.warn("matrix.child_finish_failed", {
              runId,
              matrixRunId: payload.matrixRunId,
              errorCode: classifyError(error).code,
            });
          }
        }

        if (info.state === "failed" && info.errorCode !== "EXTENSION_LOAD_FAILED") {
          // Infrastructure failure. With attempts left and a transient cause the
          // run was re-queued by the persistence layer, so surface a retryable
          // error and let the job system schedule the next attempt with
          // backoff. Otherwise the job fails with the run's error code.
          // (An extension that fails to load is a real, recorded test outcome:
          // the job itself completed.)
          const retryable = isTransientRunError(info.errorCode) && attemptsRemain && !context.isCancelled();
          throw new AppError(toErrorCode(info.errorCode), { retryable, message: info.reason });
        }
        return {
          runId,
          status: info.state,
          outcome: info.state,
          errorCode: info.errorCode ?? null,
          passed: info.passed,
          failed: info.failed,
          skipped: info.skipped,
        };
      } catch (error) {
        const classified = classifyError(error);
        const current = getTestRunById(runId);
        const alreadyFinal = !current || ["completed", "failed", "timeout", "destroyed"].includes(current.status);
        if (!alreadyFinal) {
          if (context.isCancelled()) {
            finalizeCancelled(runId, "Cancelled.");
          } else if (!(classified.retryable && job.attempts < job.max_attempts)) {
            // Terminal: the run never produced results. Record that honestly.
            finalizeTestRunWithoutResults({
              id: runId,
              status: "failed",
              outcome: classified.code === "INVALID_EXTENSION" || classified.code === "EXTENSION_LOAD_FAILED" ? "FAILED" : "INFRASTRUCTURE_ERROR",
              errorCode: classified.code,
              reason: classified.userMessage,
            });
            releaseReservationForResource(runId);
            context.emit(
              "finished",
              { type: "finished", state: "failed", outcome: "INFRASTRUCTURE_ERROR", errorCode: classified.code, reason: classified.userMessage },
              "Completed",
            );
          } else if (current.status !== "queued") {
            // Retryable failure before the engine took over (e.g. storage read):
            // put the run back in the queue for the next attempt.
            requeueTestRunForRetry(runId, "Retrying after a temporary infrastructure problem.");
            context.emit("state", { type: "state", state: "queued", stage: "Queued", retry: true, errorCode: classified.code }, "Queued");
          }
        }
        throw error;
      } finally {
        activeRuns.delete(job.id);
        if (manager) manager.release(runId);
        await rm(sessionPath, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async cancel(context: JobContext<"AUTOMATED_TEST">): Promise<void> {
      const active = activeRuns.get(context.job.id);
      if (active) {
        await active.manager.stop(active.runId, active.token).catch(() => undefined);
        return;
      }
      const row = getTestRunById(context.payload.runId);
      if (row && !["completed", "failed", "timeout", "destroyed"].includes(row.status)) {
        finalizeCancelled(context.payload.runId, "Cancelled.");
      }
    },
  };
}

/** Sandbox/infrastructure failures that a later attempt may not hit again. */
function isTransientRunError(errorCode: string | undefined): boolean {
  return errorCode === "SANDBOX_UNAVAILABLE" || errorCode === "CONCURRENCY_LIMIT" || errorCode === "STORAGE_ERROR";
}

function finalizeCancelled(runId: string, reason: string): void {
  finalizeTestRunWithoutResults({ id: runId, status: "destroyed", outcome: "CANCELLED", errorCode: "JOB_CANCELLED", reason });
  releaseReservationForResource(runId);
}
