import type {
  ExtensionLoadState,
  RuntimeEvent,
  RuntimeReport,
  SandboxStatus,
} from "@/types/runtime";

/**
 * Build a separated static + runtime report from a sandbox snapshot.
 *
 * Runtime markers are only "passed" when real states/events have been
 * observed. Never invent results.
 */

export function computeExtensionState(
  manifestVersionLabel: string,
  events: RuntimeEvent[],
  sawServiceWorker: boolean,
): {
  extensionState: ExtensionLoadState;
  serviceWorkerState: ExtensionLoadState;
  contentScriptsState: ExtensionLoadState;
  popupState: ExtensionLoadState;
} {
  const loaded = events.some(
    (event) =>
      event.type === "extension" &&
      /loaded|ready|active/i.test(event.message),
  );
  const failed = events.some(
    (event) =>
      event.type === "extension" &&
      /failed|error|load failed/i.test(event.message),
  );

  const extensionState: ExtensionLoadState = failed
    ? "failed"
    : loaded
      ? "loaded"
      : "detected";

  return {
    extensionState,
    serviceWorkerState: sawServiceWorker
      ? "loaded"
      : extensionState === "failed"
        ? "unavailable"
        : "detected",
    contentScriptsState: extensionState === "loaded" ? "detected" : "unavailable",
    popupState: manifestVersionLabel.length > 0 ? "detected" : "unavailable",
  };
}

export function buildRuntimeReport(input: {
  sandboxId: string;
  status: SandboxStatus;
  manifestVersionLabel: string;
  events: RuntimeEvent[];
  extensionState: ExtensionLoadState;
  serviceWorkerState: ExtensionLoadState;
  contentScriptsState: ExtensionLoadState;
  popupState: ExtensionLoadState;
  networkCount: number;
  startedAt?: number;
  completedAt?: number;
}): RuntimeReport {
  const consoleSummary = {
    info: input.events.filter((event) => event.type === "console" && event.level === "info").length,
    log: input.events.filter((event) => event.type === "console" && event.level === "log").length,
    warning: input.events.filter((event) => event.type === "console" && event.level === "warning").length,
    error: input.events.filter((event) => event.type === "console" && event.level === "error").length,
  };

  const hasPageEvent = input.events.some((event) => event.type === "page");
  const runtimeTestStatus =
    input.status === "completed"
      ? input.extensionState === "failed"
        ? "failed"
        : "passed"
      : input.status === "failed" || input.status === "timeout"
        ? "failed"
        : "not-tested";

  return {
    sandboxId: input.sandboxId,
    status: input.status,
    runtimeTestStatus,
    extension: {
      manifestVersionLabel: input.manifestVersionLabel,
      extensionState: input.extensionState,
      serviceWorkerState: input.serviceWorkerState,
      contentScriptsState: input.contentScriptsState,
      popupState: input.popupState,
    },
    consoleSummary,
    network: { requestCount: input.networkCount },
    sandbox: {
      status: input.status,
      durationMs: input.startedAt && input.completedAt
        ? Math.max(0, input.completedAt - input.startedAt)
        : 0,
    },
    runtimeSummary: {
      extensionLoading: input.extensionState === "loaded",
      pageLoading: hasPageEvent,
      contentScript: input.contentScriptsState === "detected" || input.contentScriptsState === "active",
      serviceWorker: input.serviceWorkerState === "loaded" || input.serviceWorkerState === "active",
      console:
        consoleSummary.error > 0
          ? "failed"
          : consoleSummary.warning > 0
            ? "review"
            : consoleSummary.log + consoleSummary.info > 0
              ? "passed"
              : "not-tested",
      network: input.networkCount > 0 ? "passed" : "not-tested",
    },
  };
}
