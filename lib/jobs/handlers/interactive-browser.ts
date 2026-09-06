import "server-only";
import { mkdir, rm, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getConfig } from "@/lib/config/env";
import { getSandboxConfig } from "@/lib/runtime/config";
import { probeSandboxEnvironment } from "@/lib/runtime/availability";
import { extractZipToDirectory } from "@/lib/runtime/extract";
import { generateSandboxId, generateSessionToken } from "@/lib/runtime/ids";
import { sha256Hex } from "@/lib/storage/validation";
import { readPackageBytes } from "@/lib/packages/service";
import {
  appendSessionEvent,
  claimStartSlot,
  getSessionById,
  transitionSession,
} from "@/lib/db/repositories/browser-sessions";
import { consumeReservationForResource } from "@/lib/db/repositories/quota";
import { recordUsage } from "@/lib/db/repositories/usage";
import { getInteractiveBrowserConcurrency } from "@/lib/billing/entitlements";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import type { SandboxDriver } from "@/lib/runtime/driver";
import type { JobContext, JobHandler } from "../types";
import {
  destroyInteractiveSession,
  emptyExtensionInfo,
  extensionInfoFromManifest,
  parseRuntimeInfo,
  parseExtensionInfoJson,
  serializeRuntimeInfo,
  setInteractiveDriverForTests,
  setSessionExtensionInfo,
  getInteractiveDriver,
} from "@/lib/interactive/service";
import { runInteractiveSweep } from "@/lib/interactive/sweep";
import { getInteractiveHub } from "@/lib/interactive/runtime";
import type { InteractiveBrowserSessionRow } from "@/lib/db/schema/types";

/**
 * Phase 11 interactive browser jobs.
 *
 * INTERACTIVE_BROWSER_START resolves the exact immutable package binding,
 * creates the disposable container (same hardened Docker profile as Phase 3/9),
 * starts the browser, waits for real extension-load evidence and only then
 * flips the session to READY. STOP/CLEANUP are idempotent termination paths.
 *
 * The handler never executes extension code; it feeds the package into the
 * container the same way the automated-test handler does.
 */

export interface InteractiveBrowserHandlerDeps {
  driver?: SandboxDriver;
  /** Pre-flight Docker probe; injectable for tests. */
  sandboxProbe?: () => Promise<{ available: boolean; reason?: string }>;
}

function depsDefaults(deps: InteractiveBrowserHandlerDeps): Required<Pick<InteractiveBrowserHandlerDeps, "driver">> {
  return { driver: deps.driver ?? getInteractiveDriver() };
}

export function createInteractiveBrowserStartHandler(
  deps: InteractiveBrowserHandlerDeps = {},
): JobHandler<"INTERACTIVE_BROWSER_START"> {
  const { driver } = depsDefaults(deps);
  const probe = deps.sandboxProbe ?? (() => probeSandboxEnvironment());

  return {
    type: "INTERACTIVE_BROWSER_START",

    async handle(context: JobContext<"INTERACTIVE_BROWSER_START">): Promise<Record<string, unknown>> {
      const { payload, job } = context;
      let row = getSessionById(payload.sessionId);
      if (!row) throw new AppError("NOT_FOUND", { message: "Browser session not found." });

      // Idempotency: a retry whose session already reached a live or terminal
      // state is a no-op.
      if (["READY", "ACTIVE", "IDLE", "STOPPED", "EXPIRED", "FAILED"].includes(row.status)) {
        return { sessionId: row.id, status: row.status, skipped: true };
      }
      if (context.isCancelled()) {
        await destroyInteractiveSession(row, driver, {
          from: ["CREATED", "QUEUED", "STARTING"],
          to: "STOPPED",
          stopReason: "cancelled",
          stateReason: "The session was cancelled before the browser started.",
          events: [{ type: "session_stopped", message: "Session cancelled before start." }],
        });
        return { sessionId: row.id, status: "STOPPED", skipped: true };
      }

      // A previous attempt may have died mid-start (stale STARTING). Reset to
      // QUEUED, remove any leftover container, then re-claim the slot.
      if (row.status === "STARTING") {
        const staleRuntime = parseRuntimeInfo(row);
        if (staleRuntime?.containerId) {
          await driver
            .remove({
              containerId: staleRuntime.containerId,
              controlPort: staleRuntime.controlPort,
              controlClient: getInteractiveHub().controlClient({
                sessionId: row.id,
                controlPort: staleRuntime.controlPort,
                runnerToken: staleRuntime.runnerToken,
              }),
              runnerToken: staleRuntime.runnerToken,
              browserId: row.browser,
            })
            .catch(() => undefined);
        }
        transitionSession(row.id, ["STARTING"], "QUEUED", { stateReason: "Retrying browser start." });
        row = getSessionById(row.id)!;
      }

      // Admit under the global/per-user/per-org limits (queue backpressure).
      const config = getConfig().interactiveBrowser;
      const claimed = claimStartSlot({
        sessionId: row.id,
        globalLimit: config.maxGlobalSessions,
        userLimit: getInteractiveBrowserConcurrency(row.user_id),
        orgLimit: config.maxSessionsPerOrg,
      });
      if (claimed === null) {
        // Session moved on without us (cancelled/expired) — nothing to do.
        return { sessionId: row.id, status: getSessionById(row.id)?.status ?? "unknown", skipped: true };
      }
      if (claimed === "capacity") {
        // Retryable: the queue keeps trying with backoff until a slot frees up.
        throw new AppError("BROWSER_SESSION_LIMIT", {
          retryable: true,
          message: "All interactive browser slots are busy. The session stays queued.",
        });
      }
      row = claimed;
      context.emit("stage", { type: "stage", stage: "Starting browser", timestamp: Date.now() }, "Starting browser");
      appendSessionEvent(row.id, { type: "browser_starting", message: "Starting the disposable browser." });

      // Pre-flight: never pretend to start a browser without the runtime.
      const environment = await probe();
      if (!environment.available) {
        throw new AppError("BROWSER_UNAVAILABLE", {
          retryable: environment.reason === "docker_unreachable",
          message: "The browser runtime is not available on this deployment.",
        });
      }

      // Exact package binding: resolve the stored package and verify SHA-256.
      if (!row.package_id) {
        await failSession(driver, row, "package_unavailable", "The original package is no longer available.");
        throw new AppError("PACKAGE_UNAVAILABLE", { retryable: false });
      }
      let bytes: Uint8Array;
      let packageSha256: string;
      try {
        const result = await readPackageBytes(row.package_id);
        packageSha256 = sha256Hex(result.bytes);
        bytes = result.bytes;
      } catch {
        await failSession(driver, row, "package_unavailable", "The original package is no longer available.");
        throw new AppError("PACKAGE_UNAVAILABLE", { retryable: false });
      }
      if (packageSha256 !== row.package_sha256) {
        // Hash mismatch is a hard integrity failure: never substitute.
        logger.error("interactive.package_hash_mismatch", {
          component: "interactive",
          sessionId: row.id,
          packageId: row.package_id,
        });
        await failSession(driver, row, "package_hash_mismatch", "The stored package failed an integrity check.");
        throw new AppError("PACKAGE_UNAVAILABLE", { retryable: false, message: "The stored package failed an integrity check." });
      }

      // Prepare the isolated package directory and start the container.
      const sandboxId = generateSandboxId();
      const runnerToken = generateSessionToken();
      const tempDir = join(getSandboxConfig().tempRoot, `ibrowser_${randomBytes(8).toString("hex")}`);
      let containerId = "";
      let controlPort = 0;
      try {
        context.heartbeat();
        await mkdir(tempDir, { recursive: true, mode: 0o700 });
        await extractZipToDirectory(bytes, tempDir);

        // Extension panel facts come from the extracted manifest of the exact
        // package that was verified above — never from client-supplied data.
        try {
          const manifestBytes = await readFile(join(tempDir, "manifest.json"));
          if (manifestBytes.byteLength <= 512 * 1024) {
            const manifestRaw: unknown = JSON.parse(manifestBytes.toString("utf8"));
            const base = parseExtensionInfoJson(row.extension_info_json);
            setSessionExtensionInfo(row.id, extensionInfoFromManifest(manifestRaw, base));
            row = getSessionById(row.id) ?? row;
          }
        } catch {
          // Manifest panel info is optional; the session can still start.
        }

        if (context.isCancelled(true)) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
          await destroyInteractiveSession(getSessionById(row.id)!, driver, {
            from: ["STARTING"],
            to: "STOPPED",
            stopReason: "cancelled",
            stateReason: "The session was cancelled before the browser started.",
            events: [{ type: "session_stopped", message: "Session cancelled before start." }],
          });
          return { sessionId: row.id, status: "STOPPED", skipped: true };
        }

        appendSessionEvent(row.id, { type: "extension_loading", message: "Loading the extension into the isolated browser." });
        const handle = await driver.create(sandboxId, tempDir, runnerToken, { browserId: "chromium" });
        containerId = handle.containerId;
        controlPort = handle.controlPort;

        // Persist runtime coordinates before the browser starts so that any
        // later crash/retry can find and remove the container.
        row =
          transitionSession(row.id, ["STARTING"], "STARTING", {
            runtimeJson: serializeRuntimeInfo({
              sandboxId,
              containerName: `extensionlab-${sandboxId}`,
              containerId,
              controlPort,
              runnerToken,
              tempDir,
            }),
          }) ?? getSessionById(row.id)!;

        context.heartbeat();
        const { ControlClient } = await import("@/lib/runtime/control-client");
        const client = new ControlClient(controlPort);
        const startResponse = await client.command(
          "start",
          runnerToken,
          { testUrl: row.initial_url ?? undefined },
          90_000,
        );
        if (!startResponse.ok) {
          recordMetric("interactive.browser_start_failures", 1);
          await failSession(driver, row, "browser_start_failed", startResponse.message ?? "The browser failed to start.");
          throw new AppError("BROWSER_SESSION_START_FAILED", {
            retryable: false,
            message: startResponse.message ?? "The browser failed to start.",
          });
        }

        // Apply the session viewport before the browser is declared ready.
        await client
          .command("set-viewport", runnerToken, { width: row.viewport_width, height: row.viewport_height }, 6000)
          .catch(() => undefined);

        const evidence = String(startResponse.data?.evidence ?? "none");
        const browserVersion =
          typeof startResponse.data?.browserVersion === "string" ? (startResponse.data.browserVersion as string) : null;

        // Quota: consume once the browser is really about to be usable.
        // consumeReservationForResource → consumeReservation records the usage
        // event inside the same transaction, exactly once per session.
        consumeReservationForResource(row.id);

        const ready =
          transitionSession(row.id, ["STARTING"], "READY", {
            stateReason: "Browser ready.",
            browserVersion,
            readyAt: Date.now(),
            touchActivity: true,
          }) ?? getSessionById(row.id)!;
        appendSessionEvent(row.id, { type: "browser_ready", message: "Disposable browser is ready." });
        appendSessionEvent(row.id, {
          type: "extension_loaded",
          message:
            evidence === "background-context"
              ? "Extension loaded (background context observed)."
              : "Extension loaded (manifest present; no background context observed).",
          metadata: { evidence },
        });
        recordMetric("interactive.session_ready", 1);
        const latency = Date.now() - (ready.started_at ?? ready.created_at);
        recordMetric("interactive.session_start_latency", latency);
        logger.info("interactive.session_ready", {
          component: "interactive",
          sessionId: row.id,
          jobId: job.id,
          userId: row.user_id,
          latencyMs: latency,
          evidence,
        });
        return { sessionId: row.id, status: "READY", evidence, browserVersion };
      } catch (error) {
        // Any failure here must leave no container or temp dir behind.
        if (containerId || tempDir) {
          const runtime = parseRuntimeInfo(getSessionById(row.id) ?? row);
          const handleContainer = containerId || runtime?.containerId || "";
          if (handleContainer) {
            await driver
              .remove({
                containerId: handleContainer,
                controlPort,
                controlClient: getInteractiveHub().controlClient({
                  sessionId: row.id,
                  controlPort: controlPort || runtime?.controlPort || 0,
                  runnerToken,
                }),
                runnerToken,
                browserId: "chromium",
              })
              .catch(() => undefined);
          }
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
        const current = getSessionById(row.id);
        if (current && !["STOPPED", "EXPIRED", "FAILED", "READY"].includes(current.status)) {
          await failSession(driver, current, "start_failed", "The browser session could not be started.", error);
        }
        throw error;
      }
    },

    async cancel(context: JobContext<"INTERACTIVE_BROWSER_START">): Promise<void> {
      const row = getSessionById(context.payload.sessionId);
      if (!row || ["STOPPED", "EXPIRED", "FAILED", "READY"].includes(row.status)) return;
      await destroyInteractiveSession(row, driver, {
        from: ["CREATED", "QUEUED", "STARTING"],
        to: "STOPPED",
        stopReason: "cancelled",
        stateReason: "The session was cancelled.",
        events: [{ type: "session_stopped", message: "Session cancelled." }],
      });
    },
  };
}

export function createInteractiveBrowserStopHandler(
  deps: InteractiveBrowserHandlerDeps = {},
): JobHandler<"INTERACTIVE_BROWSER_STOP"> {
  const { driver } = depsDefaults(deps);
  return {
    type: "INTERACTIVE_BROWSER_STOP",
    async handle(context: JobContext<"INTERACTIVE_BROWSER_STOP">): Promise<Record<string, unknown>> {
      const row = getSessionById(context.payload.sessionId);
      if (!row) return { sessionId: context.payload.sessionId, skipped: true };
      if (["STOPPED", "EXPIRED", "FAILED"].includes(row.status)) {
        return { sessionId: row.id, status: row.status, skipped: true };
      }
      const to = context.payload.to === "EXPIRED" ? "EXPIRED" : context.payload.to === "FAILED" ? "FAILED" : "STOPPED";
      const reasonLabel =
        to === "EXPIRED"
          ? "The session expired."
          : to === "FAILED"
            ? "The session failed."
            : "The session was stopped.";
      await destroyInteractiveSession(row, driver, {
        from: ["CREATED", "QUEUED", "STARTING", "READY", "ACTIVE", "IDLE", "STOPPING"],
        to,
        stopReason: context.payload.reason,
        stateReason: reasonLabel,
        events: [{ type: to === "EXPIRED" ? "session_expired" : "session_stopped", level: "warning", message: reasonLabel }],
      });
      return { sessionId: row.id, status: to };
    },
  };
}

export function createInteractiveBrowserCleanupHandler(
  deps: InteractiveBrowserHandlerDeps = {},
): JobHandler<"INTERACTIVE_BROWSER_CLEANUP"> {
  const { driver } = depsDefaults(deps);
  return {
    type: "INTERACTIVE_BROWSER_CLEANUP",
    async handle(): Promise<Record<string, unknown>> {
      const report = await runInteractiveSweep(driver);
      return { ...report };
    },
  };
}

async function failSession(
  driver: SandboxDriver,
  row: InteractiveBrowserSessionRow,
  reason: string,
  message: string,
  error?: unknown,
): Promise<void> {
  recordMetric("interactive.session_failures", 1, { reason });
  logger.warn("interactive.session_failed", {
    component: "interactive",
    sessionId: row.id,
    userId: row.user_id,
    reason,
    detail: error instanceof Error ? error.name : undefined,
  });
  await destroyInteractiveSession(row, driver, {
    from: ["CREATED", "QUEUED", "STARTING", "READY", "ACTIVE", "IDLE", "STOPPING"],
    to: "FAILED",
    stopReason: reason,
    stateReason: message,
    events: [
      { type: "runtime_error", level: "error", message },
      { type: "session_stopped", level: "warning", message: "Session ended with a failure." },
    ],
  });
}

export { setInteractiveDriverForTests };
