/**
 * Phase 3 runtime / sandbox types.
 *
 * These types describe the contract between the Tester UI, the API server,
 * the SandboxManager, and the isolated browser runner. The runner only runs
 * inside a freshly-created disposable container.
 */

export type SandboxStatus =
  | "idle"
  | "preparing"
  | "creating"
  | "starting"
  | "loading_extension"
  | "ready"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "timeout"
  | "destroyed";

export type RuntimeEventType =
  | "sandbox"
  | "browser"
  | "extension"
  | "console"
  | "network"
  | "page"
  | "error";

export type RuntimeEventLevel =
  | "debug"
  | "info"
  | "log"
  | "warning"
  | "error";

export type SandboxAction =
  | "start"
  | "stop"
  | "reload"
  | "restart-extension"
  | "open-url"
  | "clear-console"
  // Phase 11 interactive commands (validated allowlist; no CDP passthrough).
  | "go-back"
  | "go-forward"
  | "set-viewport"
  | "input"
  | "open-popup"
  | "close-popup"
  | "get-url";

export interface RuntimeEvent {
  id: string;
  timestamp: number;
  type: RuntimeEventType;
  level: RuntimeEventLevel;
  source: string;
  message: string;
  /** Bounded, always treated as untrusted text/metadata. */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface NetworkEntry {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  duration: number;
}

export type ExtensionLoadState =
  | "detected"
  | "loading"
  | "loaded"
  | "active"
  | "idle"
  | "failed"
  | "unavailable";

export interface ExtensionRuntimeStatus {
  manifestVersionLabel: string;
  extensionState: ExtensionLoadState;
  serviceWorkerState: ExtensionLoadState;
  serviceWorkerFile?: string;
  contentScriptsState: ExtensionLoadState;
  popupState: ExtensionLoadState;
  popupPath?: string;
  message?: string;
}

export interface SandboxInfo {
  sandboxId: string;
  status: SandboxStatus;
  browser: {
    product: string;
    version: string;
    state: "starting" | "running" | "stopped";
  };
  extension?: ExtensionRuntimeStatus;
  testUrl?: string;
  startedAt?: number;
  createdAt: number;
  completedAt?: number;
  reason?: string;
  referenceId: string;
}

export interface RuntimeSummary {
  extensionLoading: boolean;
  pageLoading: boolean;
  contentScript: boolean;
  serviceWorker: boolean;
  console: "passed" | "review" | "failed" | "not-tested";
  network: "passed" | "review" | "failed" | "not-tested";
}

export interface RuntimeReport {
  sandboxId: string;
  status: SandboxStatus;
  runtimeTestStatus: "passed" | "failed" | "not-tested" | "unavailable";
  extension: ExtensionRuntimeStatus;
  consoleSummary: {
    info: number;
    log: number;
    warning: number;
    error: number;
  };
  network: {
    requestCount: number;
  };
  sandbox: {
    status: SandboxStatus;
    durationMs: number;
  };
  runtimeSummary: RuntimeSummary;
}

export interface CreateSandboxRequest {
  testUrl?: string;
}

export interface CreateSandboxResponse {
  sandboxId: string;
  sessionToken: string;
  referenceId: string;
  status: SandboxStatus;
}

export interface SandboxCommandResponse {
  ok: boolean;
  status: SandboxStatus;
  message?: string;
}

export interface SandboxSnapshot {
  sandboxId: string;
  token: string;
  referenceId: string;
  status: SandboxStatus;
  testUrl?: string;
  sourcePath: string;
  /** Phase 9: browser runtime this sandbox was created for. */
  browserId?: string;
  /** Phase 9: runtime-detected browser version, once the runner reports it. */
  browserVersion?: string;
  containerId?: string;
  controlPort?: number;
  createdAt: number;
  expiresAt: number;
  startedAt?: number;
  completedAt?: number;
  stateReason?: string;
  events: RuntimeEvent[];
  network: NetworkEntry[];
  browserInfo?: {
    product: string;
    version: string;
  };
  extension?: ExtensionRuntimeStatus;
  suppressedEvents: number;
}
