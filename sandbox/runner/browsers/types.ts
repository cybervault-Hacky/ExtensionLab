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
