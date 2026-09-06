/**
 * Phase 11 interactive browser types.
 *
 * Shared contract between the workspace UI, the authenticated API, the
 * interactive session service and the runtime hub. Everything the client can
 * send is a typed, allowlisted command — there is no generic protocol
 * passthrough of any kind.
 */

export type InteractiveBrowserSessionStatus =
  | "CREATED"
  | "QUEUED"
  | "STARTING"
  | "READY"
  | "ACTIVE"
  | "IDLE"
  | "STOPPING"
  | "STOPPED"
  | "EXPIRED"
  | "FAILED";

export const INTERACTIVE_TERMINAL_STATUSES: readonly InteractiveBrowserSessionStatus[] = [
  "STOPPED",
  "EXPIRED",
  "FAILED",
];

export function isInteractiveTerminalStatus(status: InteractiveBrowserSessionStatus): boolean {
  return (INTERACTIVE_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Browsers that may launch an interactive session today (Phase 9 registry ids). */
export type InteractiveBrowserId = "chromium";

/** Safe extension metadata surfaced by the Extension details panel. */
export interface InteractiveExtensionInfo {
  name: string | null;
  version: string | null;
  manifestVersion: string | null;
  popupPath: string | null;
  hasServiceWorker: boolean;
  hasContentScripts: boolean;
  contentScriptMatches: string[];
  permissions: string[];
  hostPermissions: string[];
}

/** Public session projection. Never contains runtime internals. */
export interface InteractiveBrowserSessionView {
  id: string;
  projectId: string | null;
  packageName: string | null;
  packageId: string | null;
  packageVersion: string | null;
  packageSha256: string;
  browser: string;
  browserVersion: string | null;
  status: InteractiveBrowserSessionStatus;
  stateReason: string | null;
  stopReason: string | null;
  currentUrl: string | null;
  initialUrl: string | null;
  viewport: { width: number; height: number };
  popupOpen: boolean;
  popupSize: { width: number; height: number } | null;
  artifactCount: number;
  extension: InteractiveExtensionInfo;
  /** Phase 12: evidence-derived runtime status (never "RUNNING" without proof). */
  extensionRuntimeStatus: import("./interactive").ExtensionRuntimeStatus;
  /** Phase 12: honest failure classification (null when no failure). */
  failureKind: import("./interactive").SessionFailureKind;
  createdAt: number;
  startedAt: number | null;
  readyAt: number | null;
  lastActivityAt: number | null;
  expiresAt: number;
  stoppedAt: number | null;
  limits: {
    maxSessionMinutes: number;
    idleTimeoutMs: number;
    frameIntervalMs: number;
  };
}

/** Structured session event (lifecycle + observed runtime evidence). */
export interface InteractiveSessionEventView {
  seq: number;
  type: string;
  level: "info" | "warning" | "error";
  message: string;
  metadata: Record<string, string | number | boolean | null>;
  timestamp: number;
}

export type InteractiveSessionEventType =
  | "session_created"
  | "browser_starting"
  | "browser_ready"
  | "extension_loading"
  | "extension_loaded"
  | "navigation"
  | "popup_opened"
  | "popup_closed"
  | "extension_reloaded"
  | "runtime_error"
  | "session_stopping"
  | "session_stopped"
  | "session_expired"
  | "session_queued"
  | "viewport_changed"
  | "screenshot_captured"
  | "input"
  // Phase 12 events.
  | "browser_restart_requested"
  | "browser_restarted"
  | "browser_state_cleared"
  | "extension_reload_requested"
  | "evidence_saved"
  | "test_created"
  | "test_run_started"
  | "user_action";

/** Allowlisted input actions. No arbitrary CDP payloads, ever. */
export type BrowserInputAction =
  | { type: "pointer_move"; x: number; y: number; target?: InputTarget }
  | { type: "pointer_down"; x: number; y: number; button?: PointerButton; target?: InputTarget }
  | { type: "pointer_up"; x: number; y: number; button?: PointerButton; target?: InputTarget }
  | { type: "click"; x: number; y: number; button?: PointerButton; target?: InputTarget }
  | { type: "double_click"; x: number; y: number; button?: PointerButton; target?: InputTarget }
  | { type: "type_text"; text: string; target?: InputTarget }
  | { type: "key_press"; key: string; target?: InputTarget }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number; target?: InputTarget };

export type InputTarget = "page" | "popup";
export type PointerButton = "left" | "right";

/** Navigation operations, all passing the same safe URL policy. */
export type NavigationOperation =
  | { op: "navigate"; url: string }
  | { op: "back" }
  | { op: "forward" }
  | { op: "reload" };

export interface ConsoleEntryView {
  id: string;
  timestamp: number;
  level: "log" | "info" | "warning" | "error";
  source: string;
  message: string;
}

export interface NetworkEntryView {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  duration: number;
}

export interface ScreenshotArtifactView {
  id: string;
  label: string | null;
  size: number;
  createdAt: number;
  expiresAt: number;
  url: string;
}

// ---------------------------------------------------------------------------
// Phase 12: testing workspace extensions
// ---------------------------------------------------------------------------

/**
 * Extension runtime status derived ONLY from observed runtime evidence
 * (load evidence, extension-origin console/service-worker events, recorded
 * errors). Never inferred from "the API call succeeded".
 */
export type ExtensionRuntimeStatus =
  | "LOADING"
  | "READY"
  | "RUNNING"
  | "RELOADING"
  | "ERROR"
  | "STOPPED";

/** Honest failure classification; distinct causes stay distinct. */
export type SessionFailureKind =
  | "browser_crash"
  | "extension_load_failed"
  | "extension_runtime_error"
  | "page_error"
  | "infrastructure_error"
  | null;

/** Bounded element metadata from the fixed in-container inspection script. */
export interface ElementInspectionView {
  exists: boolean;
  tag: string | null;
  id: string | null;
  classes: string[];
  attributes: Array<{ name: string; value: string }>;
  textPreview: string | null;
  isPassword: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
  /** Deterministic selector suggestion validated against Phase 4 rules. */
  suggestedSelector: string | null;
}

/** Evidence kinds reference real runtime records; payloads are not copied. */
export type SessionEvidenceKind = "console" | "network" | "event" | "screenshot" | "test_recipe";

export interface SessionEvidenceView {
  id: string;
  sessionId: string;
  kind: SessionEvidenceKind;
  refId: string | null;
  label: string | null;
  summary: string;
  metadata: Record<string, string | number | boolean | null>;
  packageVersion: string | null;
  packageSha256: string;
  browser: string;
  browserVersion: string | null;
  reportId: string | null;
  createdAt: number;
}

/** A reusable test draft built from session actions (Phase 4 schema). */
export interface SessionTestRecipeView {
  id: string;
  sessionId: string;
  name: string;
  steps: Array<Record<string, string | number>>;
  assertions: Array<Record<string, string>>;
  createdAt: number;
}
