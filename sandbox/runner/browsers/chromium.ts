import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import CDP, { List, type CdpClient, type TargetInfo } from "chrome-remote-interface";
import type { EventHub } from "../events";
import { redactUrl, sanitizeText, truncate } from "../security";
import {
  reportBrowserVersion,
  type BrowserAdapterOptions,
  type ElementInspection,
  type ExtensionLoadEvidence,
  type InteractiveCommandResult,
  type InteractiveInputAction,
  type SandboxBrowser,
  type SandboxBrowserId,
} from "./types";

/**
 * Chromium-engine adapter (Chromium and Microsoft Edge).
 *
 * Both browsers run the Chromium engine, so they share this implementation;
 * only the executable, display name and a few startup flags differ. Diagnostics
 * are collected through CDP: console, network, page events, service-worker
 * lifecycle and runtime errors. The adapter never exposes raw CDP commands.
 */

interface ConsoleEvent {
  type: string;
  args?: Array<{ value?: unknown; description?: string; type?: string }>;
}

interface ExceptionEvent {
  exceptionDetails?: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface LogEntryEvent {
  entry?: {
    level?: string;
    text?: string;
    url?: string;
    lineNumber?: number;
  };
}

interface NetworkRequestEvent {
  requestId: string;
  request?: { method?: string; url?: string; headers?: Record<string, string> };
  type?: string;
}

interface NetworkResponseEvent {
  requestId: string;
  response?: { status?: number; url?: string; headers?: Record<string, string> };
}

interface ServiceWorkerVersionEvent {
  versions?: Array<{
    versionId: string;
    scriptURL: string;
    runningStatus: string;
    status: string;
  }>;
}

interface PageLoadEvent {
  frameId: string;
  loaderId?: string;
}

function getErrorMessage(params: unknown): string {
  const value = params as ExceptionEvent | LogEntryEvent | undefined;
  if (value && "exceptionDetails" in value) {
    const details = value.exceptionDetails;
    if (details) {
      return `${details.text ?? "Runtime exception"} at ${details.url ?? "unknown"}:${(details.lineNumber ?? 0) + 1}:${(details.columnNumber ?? 0) + 1}`;
    }
  }
  if (value && "entry" in value && value.entry?.text) return value.entry.text;
  return "An error occurred.";
}

function clampInt(value: unknown, min: number, max: number): number {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return 0;
  return Math.min(max, Math.max(min, num));
}

/** Central, non-negotiable browser flags. No caller can add arbitrary flags. */
function chromiumFlags(extensionPath: string): string[] {
  return [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    "--user-data-dir=/tmp/browser-profile",
    "--window-size=1280,800",
    "--load-extension=" + extensionPath,
    "--disable-extensions-except=" + extensionPath,
    "--disable-features=TranslateUI,site-per-process",
    "--no-sandbox",
    "about:blank",
  ];
}

/**
 * Deterministic extension id for an unpacked extension: Chromium derives it
 * from SHA-256 of the absolute load path (hex nibbles mapped to a-p). The
 * extension is always copied to /tmp/extension, so the id is stable per
 * session and independent of any client input.
 */
function extensionIdForPath(path: string): string {
  const hash = createHash("sha256").update(path).digest("hex");
  let id = "";
  for (const nibble of hash.slice(0, 32)) id += String.fromCharCode(97 + parseInt(nibble, 16));
  return id;
}

const INPUT_KEY_MAP: Record<string, { keyCode: number; code: string; text?: string }> = {
  Enter: { keyCode: 13, code: "Enter", text: "\r" },
  Tab: { keyCode: 9, code: "Tab", text: "\t" },
  Escape: { keyCode: 27, code: "Escape" },
  Backspace: { keyCode: 8, code: "Backspace" },
  Delete: { keyCode: 46, code: "Delete" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  Home: { keyCode: 36, code: "Home" },
  End: { keyCode: 35, code: "End" },
  PageUp: { keyCode: 33, code: "PageUp" },
  PageDown: { keyCode: 34, code: "PageDown" },
  Space: { keyCode: 32, code: "Space", text: " " },
};

function keyDescriptor(key: string): { keyCode: number; code: string; text?: string; key: string } | null {
  if (INPUT_KEY_MAP[key]) return { ...INPUT_KEY_MAP[key], key };
  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    return { keyCode: upper.charCodeAt(0), code: `Key${upper}`, text: key, key };
  }
  if (/^[0-9]$/.test(key)) {
    return { keyCode: key.charCodeAt(0), code: `Digit${key}`, text: key, key };
  }
  return null;
}

function edgeFlags(extensionPath: string): string[] {
  // Edge runs the same engine; a few Edge-specific quiet flags keep behavior
  // identical to the Chromium baseline.
  return [
    "--disable-features=msEdgeShoppingAssist,msSmartScreenProtection,TranslateUI,site-per-process",
    ...chromiumFlags(extensionPath).filter((flag) => flag !== "--disable-features=TranslateUI,site-per-process"),
  ];
}

export interface ChromiumBrowserConfig {
  browserId: SandboxBrowserId;
  displayName: string;
  executable: string;
  buildFlags: (extensionPath: string) => string[];
}

export class ChromiumEngineBrowser implements SandboxBrowser {
  private process: ChildProcess | null = null;
  private client: CdpClient | null = null;
  private pageTarget: TargetInfo | null = null;
  private started = false;
  private sawServiceWorker = false;
  private readonly port = 9222;

  // Phase 11 interactive state.
  private browserInfo: { product: string; version: string } | null = null;
  private extensionPath = "/tmp/extension";
  private extensionOrigin: string | null = null;
  private currentUrl = "about:blank";
  private viewport = { width: 1280, height: 800 };
  private popupClient: CdpClient | null = null;
  private popupTargetId: string | null = null;
  private popupSize = { width: 380, height: 600 };

  readonly browserId: SandboxBrowserId;
  private readonly displayName: string;
  private readonly executable: string;
  private readonly buildFlags: (extensionPath: string) => string[];

  constructor(config: ChromiumBrowserConfig, private readonly events: EventHub) {
    this.browserId = config.browserId;
    this.displayName = config.displayName;
    this.executable = config.executable;
    this.buildFlags = config.buildFlags;
  }

  async start(extensionPath: string, testUrl: string): Promise<boolean> {
    this.events.emit({ type: "browser", level: "info", source: "browser", message: `Starting isolated ${this.displayName}.` });
    return this.launch(extensionPath, testUrl);
  }

  private async launch(extensionPath: string, testUrl: string): Promise<boolean> {
    this.extensionPath = extensionPath;

    this.process = spawn("xvfb-run", ["-a", this.executable, ...this.buildFlags(extensionPath)], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process.on("exit", (code) => {
      this.started = false;
      this.events.emit({ type: "browser", level: "warning", source: "browser", message: `${this.displayName} exited (code ${code ?? "unknown"}).` });
    });

    const alive = await this.waitForCdp();
    if (!alive) {
      this.events.emit({ type: "extension", level: "error", source: "browser", message: "Browser startup failed." });
      return false;
    }

    this.events.emit({ type: "browser", level: "info", source: "browser", message: "Browser started. Loading unpacked extension." });
    await this.detectVersion();
    // Apply any viewport chosen before this launch (extension reload path).
    await this.applyViewport(this.viewport.width, this.viewport.height);
    await this.openPage(testUrl);
    this.started = true;
    return true;
  }

  async openPage(url: string): Promise<void> {
    if (!this.client || !this.pageTarget) return;
    this.currentUrl = url;
    this.events.emit({ type: "page", level: "info", source: "page", message: `Opening ${redactUrl(url)}` });
    await this.client.Page.navigate({ url });
  }

  async reload(): Promise<void> {
    if (!this.client) return;
    await this.client.Page.reload({ ignoreCache: true });
    this.events.emit({ type: "page", level: "info", source: "page", message: "Page reload requested." });
  }

  async captureScreenshot(): Promise<Uint8Array | null> {
    if (!this.client) return null;
    const result = await this.client.Page.captureScreenshot({ format: "png" });
    return Buffer.from(result.data, "base64");
  }

  async inspectElement(selector: string): Promise<ElementInspection> {
    if (!this.client) return { exists: false, visible: false };
    const json = JSON.stringify(selector);
    const expression = `(() => { try { const el = document.querySelector(${json}); if (!el) return { exists: false, visible: false }; const r = el.getBoundingClientRect(); return { exists: true, visible: (r.width > 0 && r.height > 0) || (el.getClientRects().length > 0), text: (el.textContent || "").slice(0, 500) }; } catch (e) { return { exists: false, visible: false }; } })()`;
    const result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    const value = result.result?.value;
    if (value && typeof value === "object") {
      const inspected = value as { exists?: boolean; visible?: boolean; text?: string };
      return { exists: inspected.exists === true, visible: inspected.visible === true, text: inspected.text };
    }
    return { exists: false, visible: false };
  }

  async inspectText(selector: string): Promise<string> {
    if (!this.client) return "";
    const json = JSON.stringify(selector);
    const expression = `(() => { const el = document.querySelector(${json}); return el ? String((el.textContent || "").slice(0, 2000)) : ""; })()`;
    const result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    return String(result.result?.value ?? "");
  }

  async click(selector: string): Promise<boolean> {
    if (!this.client) return false;
    const json = JSON.stringify(selector);
    const expression = `(() => { const el = document.querySelector(${json}); if (!el) return false; el.click(); return true; })()`;
    const result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    return result.result?.value === true;
  }

  async type(selector: string, value: string): Promise<boolean> {
    if (!this.client) return false;
    const jsonSelector = JSON.stringify(selector);
    const jsonValue = JSON.stringify(value);
    const expression = `(() => { const el = document.querySelector(${jsonSelector}); if (!el) return false; el.value = ${jsonValue}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;
    const result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    return result.result?.value === true;
  }

  async select(selector: string, value: string): Promise<boolean> {
    if (!this.client) return false;
    const jsonSelector = JSON.stringify(selector);
    const jsonValue = JSON.stringify(value);
    const expression = `(() => { const el = document.querySelector(${jsonSelector}); if (!el) return false; el.value = ${jsonValue}; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;
    const result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    return result.result?.value === true;
  }

  async scroll(selector: string): Promise<boolean> {
    if (!this.client) return false;
    const json = JSON.stringify(selector);
    const expression = `(() => { const el = document.querySelector(${json}); if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })()`;
    const result = await this.client.Runtime.evaluate({ expression, returnByValue: true });
    return result.result?.value === true;
  }

  async getPageUrl(): Promise<string> {
    if (!this.client) return "";
    const result = await this.client.Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return String(result.result?.value ?? "");
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.detachPopup();
    try {
      await this.client?.close();
    } catch {
      // Already closed.
    }
    this.client = null;
    this.process?.kill("SIGTERM");
    this.process = null;
    this.events.emit({ type: "browser", level: "info", source: "browser", message: "Browser stopped." });
  }

  isStarted(): boolean {
    return this.started;
  }

  // -------------------------------------------------------------------------
  // Phase 11 interactive operations
  // -------------------------------------------------------------------------

  currentViewport(): { width: number; height: number } {
    return { ...this.viewport };
  }

  getBrowserVersion(): { product: string; version: string } | null {
    return this.browserInfo ? { ...this.browserInfo } : null;
  }

  isPopupOpen(): boolean {
    return this.popupClient !== null;
  }

  /**
   * Waits for real evidence that the unpacked extension registered. A service
   * worker, background page or any chrome-extension:// target is strong
   * evidence. A readable manifest alone is weak evidence (content-script-only
   * extensions have no background context) and is reported as such.
   */
  async verifyExtensionLoaded(timeoutMs = 12000): Promise<ExtensionLoadEvidence> {
    const started = Date.now();
    for (;;) {
      const probe = await this.probeExtension();
      if (probe.loaded) return probe;
      if (Date.now() - started >= timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Weak evidence: manifest present but no background context observed.
    try {
      await readFile(`${this.extensionPath}/manifest.json`);
      return { loaded: true, evidence: "manifest-only", origin: this.expectedOrigin() };
    } catch {
      return { loaded: false, evidence: "none", origin: null };
    }
  }

  private expectedOrigin(): string {
    return `chrome-extension://${extensionIdForPath(this.extensionPath)}`;
  }

  private async probeExtension(): Promise<ExtensionLoadEvidence> {
    if (this.extensionOrigin) {
      return { loaded: true, evidence: "background-context", origin: this.extensionOrigin };
    }
    try {
      const targets = await this.client?.Target.getTargets();
      const infos = ((targets as { targetInfos?: TargetInfo[] } | undefined)?.targetInfos ?? []) as TargetInfo[];
      const extensionTarget = infos.find((info) => (info.url ?? "").startsWith("chrome-extension://"));
      if (extensionTarget) {
        this.extensionOrigin = new URL(extensionTarget.url).origin;
        return { loaded: true, evidence: "background-context", origin: this.extensionOrigin };
      }
    } catch {
      // CDP not ready yet.
    }
    return { loaded: false, evidence: "none", origin: null };
  }

  async setViewport(width: number, height: number): Promise<InteractiveCommandResult> {
    this.viewport = { width, height };
    const applied = await this.applyViewport(width, height);
    return applied
      ? { ok: true, supported: true, data: { width, height } }
      : { ok: false, supported: true, message: "The viewport could not be applied." };
  }

  private async applyViewport(width: number, height: number): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.Emulation.setDeviceMetricsOverride({
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  async goBack(): Promise<InteractiveCommandResult> {
    const moved = await this.moveHistory(-1);
    return moved ? { ok: true, supported: true } : { ok: false, supported: true, message: "No earlier page in history." };
  }

  async goForward(): Promise<InteractiveCommandResult> {
    const moved = await this.moveHistory(1);
    return moved ? { ok: true, supported: true } : { ok: false, supported: true, message: "No later page in history." };
  }

  private async moveHistory(delta: number): Promise<boolean> {
    if (!this.client) return false;
    try {
      const history = await this.client.Page.getNavigationHistory();
      const currentIndex = history.currentIndex ?? -1;
      const entries = history.entries ?? [];
      const target = entries[currentIndex + delta];
      if (!target) return false;
      await this.client.Page.navigateToHistoryEntry({ entryId: target.id });
      this.currentUrl = target.url ?? this.currentUrl;
      return true;
    } catch {
      return false;
    }
  }

  async dispatchInput(action: InteractiveInputAction): Promise<InteractiveCommandResult> {
    const client = action.target === "popup" ? this.popupClient ?? null : this.client;
    if (!client) {
      return { ok: false, supported: true, message: action.target === "popup" ? "The popup is not open." : "The browser is not running." };
    }
    const button = action.button === "right" ? "right" : "left";
    try {
      switch (action.type) {
        case "pointer_move":
          await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: action.x, y: action.y, button: "none" });
          break;
        case "pointer_down":
          await client.Input.dispatchMouseEvent({ type: "mousePressed", x: action.x, y: action.y, button, clickCount: 1 });
          break;
        case "pointer_up":
          await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: action.x, y: action.y, button, clickCount: 1 });
          break;
        case "click":
          await client.Input.dispatchMouseEvent({ type: "mousePressed", x: action.x, y: action.y, button, clickCount: 1 });
          await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: action.x, y: action.y, button, clickCount: 1 });
          break;
        case "double_click":
          await client.Input.dispatchMouseEvent({ type: "mousePressed", x: action.x, y: action.y, button, clickCount: 2 });
          await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: action.x, y: action.y, button, clickCount: 2 });
          break;
        case "type_text": {
          await client.Input.insertText({ text: String(action.text ?? "").slice(0, 2000) });
          break;
        }
        case "key_press": {
          const descriptor = keyDescriptor(String(action.key ?? ""));
          if (!descriptor) return { ok: false, supported: true, message: "This key is not supported." };
          await client.Input.dispatchKeyEvent({
            type: descriptor.text ? "keyDown" : "rawKeyDown",
            key: descriptor.key,
            code: descriptor.code,
            windowsVirtualKeyCode: descriptor.keyCode,
            nativeVirtualKeyCode: descriptor.keyCode,
            text: descriptor.text,
          });
          await client.Input.dispatchKeyEvent({
            type: "keyUp",
            key: descriptor.key,
            code: descriptor.code,
            windowsVirtualKeyCode: descriptor.keyCode,
            nativeVirtualKeyCode: descriptor.keyCode,
          });
          break;
        }
        case "scroll":
          await client.Input.dispatchMouseEvent({
            type: "mouseWheel",
            x: action.x,
            y: action.y,
            deltaX: clampInt(action.deltaX, -3000, 3000),
            deltaY: clampInt(action.deltaY, -3000, 3000),
            button: "none",
          });
          break;
        default:
          return { ok: false, supported: true, message: "Unsupported input action." };
      }
      return { ok: true, supported: true };
    } catch {
      return { ok: false, supported: true, message: "The input action could not be delivered." };
    }
  }

  /**
   * Opens the real extension popup as an extension page target rendered by
   * this browser. The popup document runs with the actual loaded extension
   * (same origin, same chrome.runtime APIs) — nothing is extracted or
   * re-rendered by the host.
   */
  async openPopup(popupPath: string): Promise<InteractiveCommandResult> {
    if (!this.client) return { ok: false, supported: true, message: "The browser is not running." };
    if (this.popupClient) return { ok: true, supported: true, data: { width: this.popupSize.width, height: this.popupSize.height } };

    const evidence = await this.probeExtension();
    const origin = this.extensionOrigin ?? (evidence.loaded ? evidence.origin : this.expectedOrigin());
    const cleanPath = popupPath.replace(/^\/+/, "");
    const url = `${origin}/${cleanPath}`;
    const size = await this.readPopupSize();
    this.popupSize = size;
    try {
      const created = (await this.client.Target.createTarget({ url })) as { targetId?: string };
      const targetId = created.targetId;
      if (!targetId) return { ok: false, supported: true, message: "The popup page could not be opened." };

      this.popupTargetId = targetId;
      this.popupClient = await CDP({ port: this.port, target: targetId });
      await this.popupClient.Runtime.enable();
      await this.popupClient.Page.enable();
      await this.popupClient.Log.enable();
      this.attachPopupListeners(this.popupClient);
      await this.popupClient.Emulation.setDeviceMetricsOverride({
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      // Verify the popup document really loaded from the extension origin.
      const started = Date.now();
      let confirmed = false;
      while (Date.now() - started < 5000) {
        try {
          const check = await this.popupClient.Runtime.evaluate({
            expression: "location.protocol === 'chrome-extension:'",
            returnByValue: true,
          });
          if (check.result?.value === true) {
            confirmed = true;
            break;
          }
        } catch {
          // Navigation still in flight.
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!confirmed) {
        await this.detachPopup();
        return { ok: false, supported: true, message: "The extension popup page did not load." };
      }

      this.events.emit({
        type: "extension",
        level: "info",
        source: "extension",
        message: "Extension popup opened in the isolated browser.",
      });
      return { ok: true, supported: true, data: { width: size.width, height: size.height } };
    } catch {
      await this.detachPopup();
      return { ok: false, supported: true, message: "The extension popup page did not load." };
    }
  }

  async closePopup(): Promise<InteractiveCommandResult> {
    if (!this.popupClient) return { ok: false, supported: true, message: "The popup is not open." };
    await this.detachPopup();
    this.events.emit({ type: "extension", level: "info", source: "extension", message: "Extension popup closed." });
    return { ok: true, supported: true };
  }

  async capturePopupScreenshot(): Promise<Uint8Array | null> {
    if (!this.popupClient) return null;
    const result = await this.popupClient.Page.captureScreenshot({ format: "png" });
    return Buffer.from(result.data, "base64");
  }

  /**
   * Reloads the extension by restarting the browser against the same isolated
   * profile and the same on-disk package — the package bytes are never
   * changed, so the reload always resolves the original immutable binding.
   */
  async restartExtension(): Promise<InteractiveCommandResult> {
    if (!this.started || !this.process) return { ok: false, supported: true, message: "The browser is not running." };
    this.events.emit({ type: "extension", level: "info", source: "extension", message: "Extension reload requested; restarting isolated browser." });
    const url = this.currentUrl;
    const viewport = { ...this.viewport };
    await this.stop();
    const ok = await this.launch(this.extensionPath, url);
    if (!ok) return { ok: false, supported: true, message: "The browser failed to restart." };
    this.viewport = viewport;
    await this.applyViewport(viewport.width, viewport.height);
    const evidence = await this.verifyExtensionLoaded(10000);
    this.events.emit({
      type: "extension",
      level: evidence.loaded ? "info" : "warning",
      source: "extension",
      message: evidence.loaded ? "Extension reloaded." : "Extension did not re-register a background context.",
    });
    return { ok: true, supported: true };
  }

  private async detachPopup(): Promise<void> {
    const client = this.popupClient;
    const targetId = this.popupTargetId;
    this.popupClient = null;
    this.popupTargetId = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // Already closed.
      }
    }
    if (targetId && this.client) {
      try {
        await this.client.Target.closeTarget({ targetId });
      } catch {
        // Target may already be gone.
      }
    }
  }

  private attachPopupListeners(client: CdpClient): void {
    client.on("Runtime.consoleAPICalled", (params) => {
      const event = params as ConsoleEvent;
      const level = event.type === "warn" ? "warning" : event.type === "error" ? "error" : event.type === "info" ? "info" : "log";
      const message = (event.args ?? [])
        .map((arg) => (typeof arg.value === "string" ? arg.value : arg.description ?? (arg.type === "object" ? "[object]" : "")))
        .filter(Boolean)
        .join(" ");
      if (message) this.events.emit({ type: "console", level, source: "popup", message: sanitizeText(message) });
    });
    client.on("Runtime.exceptionThrown", (params) => {
      this.events.emit({ type: "error", level: "error", source: "popup", message: getErrorMessage(params) });
    });
  }

  private async readPopupSize(): Promise<{ width: number; height: number }> {
    try {
      const raw = await readFile(`${this.extensionPath}/manifest.json`, "utf8");
      const manifest = JSON.parse(raw) as {
        action?: { default_width?: number; default_height?: number };
        browser_action?: { default_width?: number; default_height?: number };
      };
      const action = manifest.action ?? manifest.browser_action;
      const width = Number(action?.default_width);
      const height = Number(action?.default_height);
      return {
        width: Number.isFinite(width) && width >= 100 && width <= 800 ? Math.round(width) : 380,
        height: Number.isFinite(height) && height >= 100 && height <= 800 ? Math.round(height) : 600,
      };
    } catch {
      return { width: 380, height: 600 };
    }
  }

  private async detectVersion(): Promise<void> {
    if (!this.client) return;
    try {
      const version = await this.client.Browser.getVersion();
      const product = String(version.product ?? this.displayName).split("/")[0] || this.displayName;
      this.browserInfo = { product, version: version.version ? String(version.version) : "unknown" };
      reportBrowserVersion(this.events, product, version.version ? String(version.version) : null);
    } catch {
      this.browserInfo = { product: this.displayName, version: "unknown" };
      reportBrowserVersion(this.events, this.displayName, null);
    }
  }

  private async waitForCdp(timeoutMs = 25000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const targets = await List({ port: this.port });
        const page = targets.find((target) => target.type === "page");
        if (page) {
          this.pageTarget = page;
          this.client = await CDP({ port: this.port, target: page.id });
          await this.attachListeners();
          return true;
        }
      } catch {
        // Not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  private async attachListeners(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    await client.Runtime.enable();
    await client.Page.enable();
    await client.Network.enable();
    await client.Log.enable();
    await client.ServiceWorker.enable();
    await client.Target.setDiscoverTargets({ discover: true });

    client.on("Runtime.consoleAPICalled", (params) => {
      const event = params as ConsoleEvent;
      const level = event.type === "warn" ? "warning" : event.type === "error" ? "error" : event.type === "info" ? "info" : "log";
      const message = (event.args ?? [])
        .map((arg) => typeof arg.value === "string" ? arg.value : arg.description ?? (arg.type === "object" ? "[object]" : ""))
        .filter(Boolean)
        .join(" ");
      this.events.emit({ type: "console", level, source: "page", message: sanitizeText(message) });
    });

    client.on("Runtime.exceptionThrown", (params) => {
      this.events.emit({ type: "error", level: "error", source: "page", message: getErrorMessage(params) });
    });

    client.on("Log.entryAdded", (params) => {
      const entry = (params as LogEntryEvent).entry;
      if (entry?.text) {
        this.events.emit({ type: "console", level: entry.level === "warning" ? "warning" : entry.level === "error" ? "error" : "log", source: "log", message: sanitizeText(entry.text) });
      }
    });

    client.on("Network.requestWillBeSent", (params) => {
      const event = params as NetworkRequestEvent;
      this.events.emit({
        type: "network",
        level: "info",
        source: "network",
        message: `${event.request?.method ?? "GET"} ${redactUrl(event.request?.url ?? "")}`,
        metadata: {
          method: event.request?.method ?? "GET",
          url: redactUrl(event.request?.url ?? ""),
          resourceType: event.type ?? "network",
        },
      });
    });

    client.on("Network.responseReceived", (params) => {
      const event = params as NetworkResponseEvent;
      const status = event.response?.status ?? null;
      if (status !== null) {
        this.events.emit({
          type: "network",
          level: status >= 400 ? "warning" : "info",
          source: "network",
          message: `${status} ${redactUrl(event.response?.url ?? "")}`,
          metadata: {
            method: "RESPONSE",
            url: redactUrl(event.response?.url ?? ""),
            status,
            resourceType: "network",
          },
        });
      }
    });

    client.on("ServiceWorker.workerVersionUpdated", (params) => {
      const versions = (params as ServiceWorkerVersionEvent).versions ?? [];
      for (const version of versions) {
        const url = version.scriptURL ?? "";
        if (url.startsWith("chrome-extension://") && !this.extensionOrigin) {
          this.extensionOrigin = new URL(url).origin;
        }
      }
      if (versions.length > 0 && !this.sawServiceWorker) {
        this.sawServiceWorker = true;
        this.events.emit({ type: "extension", level: "info", source: "extension", message: "Service worker registered. Extension loaded." });
      }
    });

    client.on("Target.targetCreated", (params) => {
      const info = (params as { targetInfo?: TargetInfo }).targetInfo;
      const url = info?.url ?? "";
      if (url.startsWith("chrome-extension://") && !this.extensionOrigin) {
        this.extensionOrigin = new URL(url).origin;
      }
    });

    client.on("Page.frameNavigated", (params) => {
      const frame = (params as { frame?: { parentId?: string; url?: string } }).frame;
      // Main frame only (parentId absent) — keeps the tracked URL in sync with
      // redirects and script-driven navigation.
      if (frame && !frame.parentId && frame.url) {
        this.currentUrl = frame.url;
      }
    });

    client.on("Page.loadEventFired", (params) => {
      const event = params as PageLoadEvent;
      this.events.emit({ type: "page", level: "info", source: "page", message: `Page loaded (frame ${truncate(event.frameId, 24)}).` });
    });
  }
}

export function createChromiumBrowser(options: BrowserAdapterOptions): SandboxBrowser {
  return new ChromiumEngineBrowser(
    {
      browserId: "chromium",
      displayName: "Chromium",
      executable: process.env.EXTENSIONLAB_BROWSER_EXECUTABLE || "chromium",
      buildFlags: chromiumFlags,
    },
    options.events,
  );
}

export function createEdgeBrowser(options: BrowserAdapterOptions): SandboxBrowser {
  return new ChromiumEngineBrowser(
    {
      browserId: "edge",
      displayName: "Microsoft Edge",
      executable: process.env.EXTENSIONLAB_BROWSER_EXECUTABLE || "microsoft-edge",
      buildFlags: edgeFlags,
    },
    options.events,
  );
}
