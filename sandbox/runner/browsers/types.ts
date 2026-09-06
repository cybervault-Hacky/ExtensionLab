import type { EventHub } from "../events";

/**
 * Phase 9 in-container browser abstraction.
 *
 * The runner speaks to three disposable browser runtimes through one narrow
 * interface. Adapters expose only the safe, predefined operations the host
 * control protocol already validates; no raw automation primitives (raw CDP,
 * arbitrary flags, arbitrary scripts) are reachable from outside the sandbox.
 */

export type SandboxBrowserId = "chromium" | "edge" | "firefox";

export function isSandboxBrowserId(value: unknown): value is SandboxBrowserId {
  return value === "chromium" || value === "edge" || value === "firefox";
}

export interface ElementInspection {
  exists: boolean;
  visible: boolean;
  text?: string;
}

export interface BrowserStartResult {
  ok: boolean;
  /** Stable failure kind, mapped by the runner to user-safe messages. */
  reason?: "startup_failed" | "automation_unavailable" | "extension_install_failed";
}

/**
 * Phase 11 interactive commands. Adapters that cannot support an operation
 * report `supported: false` instead of faking success; the host surfaces the
 * limitation honestly.
 */
export interface InteractiveInputAction {
  type:
    | "pointer_move"
    | "pointer_down"
    | "pointer_up"
    | "click"
    | "double_click"
    | "type_text"
    | "key_press"
    | "scroll";
  x?: number;
  y?: number;
  button?: "left" | "right";
  text?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  target?: "page" | "popup";
}

export interface InteractiveCommandResult {
  ok: boolean;
  supported: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ExtensionLoadEvidence {
  loaded: boolean;
  /** What was actually observed, surfaced to the user as evidence. */
  evidence: "background-context" | "manifest-only" | "none";
  origin: string | null;
}

export interface SandboxBrowser {
  readonly browserId: SandboxBrowserId;
  /** Launches the browser and loads the unpacked extension at extensionPath. */
  start(extensionPath: string, testUrl: string): Promise<boolean>;
  openPage(url: string): Promise<void>;
  reload(): Promise<void>;
  captureScreenshot(): Promise<Uint8Array | null>;
  inspectElement(selector: string): Promise<ElementInspection>;
  inspectText(selector: string): Promise<string>;
  click(selector: string): Promise<boolean>;
  type(selector: string, value: string): Promise<boolean>;
  select(selector: string, value: string): Promise<boolean>;
  scroll(selector: string): Promise<boolean>;
  getPageUrl(): Promise<string>;
  stop(): Promise<void>;
  isStarted(): boolean;
  // ----- Phase 11 interactive operations (optional per runtime) -----
  /** Waits for real evidence that the unpacked extension registered. */
  verifyExtensionLoaded?(timeoutMs: number): Promise<ExtensionLoadEvidence>;
  setViewport?(width: number, height: number): Promise<InteractiveCommandResult>;
  dispatchInput?(action: InteractiveInputAction): Promise<InteractiveCommandResult>;
  goBack?(): Promise<InteractiveCommandResult>;
  goForward?(): Promise<InteractiveCommandResult>;
  openPopup?(popupPath: string): Promise<InteractiveCommandResult>;
  closePopup?(): Promise<InteractiveCommandResult>;
  /** Restarts the browser (same profile, same package) = real extension reload. */
  restartExtension?(): Promise<InteractiveCommandResult>;
  /**
   * Phase 12: full browser restart — new process against the same on-disk,
   * hash-verified package. Returns fresh extension-load evidence.
   */
  restartBrowser?(): Promise<InteractiveCommandResult>;
  /**
   * Phase 12: clears only this disposable browser's state (cookies, storage).
   * Never touches anything outside the container.
   */
  clearBrowserState?(): Promise<InteractiveCommandResult>;
  /**
   * Phase 12: bounded element inspection at viewport coordinates. Runs a
   * FIXED script (no client-supplied code) that returns only safe metadata:
   * tag/id/classes/text preview/bounded attributes/visibility/rect, with
   * password values redacted inside the container.
   */
  inspectAt?(x: number, y: number, target?: "page" | "popup"): Promise<InteractiveCommandResult>;
  capturePopupScreenshot?(): Promise<Uint8Array | null>;
  isPopupOpen?(): boolean;
  currentViewport?(): { width: number; height: number };
  /** Detected product/version after start (evidence, never client input). */
  getBrowserVersion?(): { product: string; version: string } | null;
}

export interface BrowserAdapterOptions {
  events: EventHub;
}

/** Reports the detected browser version as runner evidence (Phase 9). */
export function reportBrowserVersion(events: EventHub, product: string, version: string | null): void {
  events.emit({
    type: "browser",
    level: "info",
    source: "browser",
    message: `Browser ready: ${product}${version ? ` ${version}` : ""}.`,
    metadata: { product, version: version ?? "unknown" },
  });
}
