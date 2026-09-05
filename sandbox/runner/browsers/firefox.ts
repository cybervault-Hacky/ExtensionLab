import { spawn, type ChildProcess } from "node:child_process";
import type { EventHub } from "../events";
import { redactUrl, sanitizeText, validatePublicUrl } from "../security";
import { reportBrowserVersion, type BrowserAdapterOptions, type ElementInspection, type SandboxBrowser } from "./types";

/**
 * Firefox (Gecko) adapter.
 *
 * Firefox does not speak the Chromium DevTools protocol, so no CDP assumption
 * is forced onto it. This adapter drives Firefox through geckodriver:
 *
 *   - WebDriver HTTP commands on a loopback-only geckodriver port
 *     (navigation, fixed-expression element inspection, screenshots);
 *   - WebDriver BiDi over WebSocket for console/page-error log events
 *     (and network events when the pinned Firefox version exposes them);
 *   - temporary add-on installation (`moz/addon/install`, temporary: true) so
 *     the extension is never permanently installed into a host profile — every
 *     run uses a disposable profile under the container's tmpfs.
 *
 * All browser flags and preferences are fixed constants here. Callers can
 * never supply arbitrary flags, scripts or commands.
 */

const GECKODRIVER_PORT = 9515;
const STARTUP_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 10_000;

/** Fixed, centrally controlled Firefox flags (no caller input). */
const FIREFOX_ARGS = [
  "--headless",
  "--no-remote",
  "--foreground",
  "--width=1280",
  "--height=800",
  "--profile-root=/tmp",
] as const;

/** Fixed, centrally controlled preferences (no caller input). */
const FIREFOX_PREFS: Record<string, unknown> = {
  "browser.shell.checkDefaultBrowser": false,
  "browser.startup.page": 0,
  "startup.homepage_welcome_url": "about:blank",
  "startup.homepage_override_url": "about:blank",
  "app.update.enabled": false,
  "app.update.autoInstallOnLaunch": false,
  "extensions.update.enabled": false,
  "extensions.update.autoUpdateDefault": false,
  "toolkit.telemetry.enabled": false,
  "datareporting.healthreport.uploadEnabled": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "dom.push.connection.enabled": false,
};

interface WebDriverResponse<T = unknown> {
  value: T;
}

interface SessionCapabilities {
  browserName?: string;
  browserVersion?: string;
  webSocketUrl?: string;
  "moz:sessionID"?: string;
}

interface BidiMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GeckoBrowser implements SandboxBrowser {
  readonly browserId = "firefox" as const;

  private driverProcess: ChildProcess | null = null;
  private sessionId: string | null = null;
  private browserVersion: string | null = null;
  private bidiSocket: { close: () => void } | null = null;
  private started = false;
  private nextBidiId = 1;

  constructor(private readonly events: EventHub) {}

  async start(extensionPath: string, testUrl: string): Promise<boolean> {
    this.events.emit({ type: "browser", level: "info", source: "browser", message: "Starting isolated Firefox." });

    const geckodriver = process.env.EXTENSIONLAB_GECKODRIVER_EXECUTABLE || "geckodriver";
    this.driverProcess = spawn(geckodriver, ["--port", String(GECKODRIVER_PORT)], {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "ignore"],
    });
    this.driverProcess.on("exit", (code) => {
      this.started = false;
      this.events.emit({ type: "browser", level: "warning", source: "browser", message: `Firefox automation driver exited (code ${code ?? "unknown"}).` });
    });

    if (!(await this.waitForDriver())) {
      this.events.emit({ type: "extension", level: "error", source: "browser", message: "Browser startup failed." });
      return false;
    }

    // Session creation launches Firefox with the fixed flags/prefs.
    const session = await this.webdriver<SessionCapabilities>("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          "moz:firefoxOptions": {
            args: [...FIREFOX_ARGS],
            prefs: FIREFOX_PREFS,
          },
          webSocketUrl: true,
        },
      },
    }).catch(() => null);

    if (!session) {
      this.events.emit({ type: "extension", level: "error", source: "browser", message: "Browser startup failed." });
      return false;
    }

    this.sessionId = session["moz:sessionID"] ?? null;
    this.browserVersion = session.browserVersion ?? null;
    reportBrowserVersion(this.events, "Firefox", this.browserVersion);

    // Console + page-error events arrive over WebDriver BiDi.
    await this.connectBidi(session.webSocketUrl).catch(() => undefined);
    await this.setScriptTimeout().catch(() => undefined);

    // Temporary (disposable) add-on installation — never a permanent install.
    const installed = await this.webdriver<{ id?: string }>("POST", `/session/${this.sessionId}/moz/addon/install`, {
      path: extensionPath,
      temporary: true,
    }).catch(() => null);

    if (!installed) {
      this.events.emit({ type: "extension", level: "error", source: "extension", message: "Temporary extension installation failed." });
      await this.stop();
      return false;
    }

    this.events.emit({ type: "extension", level: "info", source: "extension", message: "Temporary extension installed. Extension loaded." });
    this.events.emit({ type: "browser", level: "info", source: "browser", message: "Browser started. Loading temporary extension." });

    await this.openPage(testUrl);
    this.started = true;
    return true;
  }

  async openPage(url: string): Promise<void> {
    const validated = validatePublicUrl(url);
    if (!validated.ok) {
      this.events.emit({ type: "page", level: "warning", source: "page", message: `Blocked navigation to a disallowed URL.` });
      return;
    }
    this.events.emit({ type: "page", level: "info", source: "page", message: `Opening ${redactUrl(validated.url)}` });
    await this.webdriver("POST", `/session/${this.sessionId}/url`, { url: validated.url }).catch(() => undefined);
  }

  async reload(): Promise<void> {
    await this.webdriver("POST", `/session/${this.sessionId}/refresh`, {}).catch(() => undefined);
    this.events.emit({ type: "page", level: "info", source: "page", message: "Page reload requested." });
  }

  async captureScreenshot(): Promise<Uint8Array | null> {
    const result = await this.webdriver<string>("GET", `/session/${this.sessionId}/screenshot`).catch(() => null);
    if (!result) return null;
    try {
      return Buffer.from(result, "base64");
    } catch {
      return null;
    }
  }

  async inspectElement(selector: string): Promise<ElementInspection> {
    const json = JSON.stringify(selector);
    const script = `return (() => { try { const el = document.querySelector(${json}); if (!el) return { exists: false, visible: false }; const r = el.getBoundingClientRect(); return { exists: true, visible: (r.width > 0 && r.height > 0) || (el.getClientRects().length > 0), text: (el.textContent || "").slice(0, 500) }; } catch (e) { return { exists: false, visible: false }; } })();`;
    const value = await this.evaluateFixed(script);
    if (value && typeof value === "object") {
      const inspected = value as { exists?: boolean; visible?: boolean; text?: string };
      return { exists: inspected.exists === true, visible: inspected.visible === true, text: inspected.text };
    }
    return { exists: false, visible: false };
  }

  async inspectText(selector: string): Promise<string> {
    const json = JSON.stringify(selector);
    const script = `return (() => { const el = document.querySelector(${json}); return el ? String((el.textContent || "").slice(0, 2000)) : ""; })();`;
    const value = await this.evaluateFixed(script);
    return typeof value === "string" ? value : "";
  }

  async click(selector: string): Promise<boolean> {
    const json = JSON.stringify(selector);
    const script = `return (() => { const el = document.querySelector(${json}); if (!el) return false; el.click(); return true; })();`;
    return (await this.evaluateFixed(script)) === true;
  }

  async type(selector: string, value: string): Promise<boolean> {
    const jsonSelector = JSON.stringify(selector);
    const jsonValue = JSON.stringify(value);
    const script = `return (() => { const el = document.querySelector(${jsonSelector}); if (!el) return false; el.value = ${jsonValue}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })();`;
    return (await this.evaluateFixed(script)) === true;
  }

  async select(selector: string, value: string): Promise<boolean> {
    return this.type(selector, value);
  }

  async scroll(selector: string): Promise<boolean> {
    const json = JSON.stringify(selector);
    const script = `return (() => { const el = document.querySelector(${json}); if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })();`;
    return (await this.evaluateFixed(script)) === true;
  }

  async getPageUrl(): Promise<string> {
    const url = await this.webdriver<string>("GET", `/session/${this.sessionId}/url`).catch(() => null);
    return typeof url === "string" ? url : "";
  }

  async stop(): Promise<void> {
    this.started = false;
    try {
      this.bidiSocket?.close();
    } catch {
      // Already closed.
    }
    this.bidiSocket = null;
    if (this.sessionId) {
      await this.webdriver("DELETE", `/session/${this.sessionId}`).catch(() => undefined);
      this.sessionId = null;
    }
    this.driverProcess?.kill("SIGTERM");
    this.driverProcess = null;
    this.events.emit({ type: "browser", level: "info", source: "browser", message: "Browser stopped." });
  }

  isStarted(): boolean {
    return this.started;
  }

  getDetectedVersion(): string | null {
    return this.browserVersion;
  }

  // -------------------------------------------------------------------------
  // Internals

  /**
   * Evaluates a *runner-owned constant* script (only the validated, escaped
   * selector/value is interpolated). User-supplied scripts never reach this
   * method: the control server only accepts the predefined safe actions.
   */
  private async evaluateFixed(script: string): Promise<unknown> {
    if (!this.started && !this.sessionId) return null;
    const result = await this.webdriver<{ value?: unknown }>("POST", `/session/${this.sessionId}/execute/sync`, {
      script,
      args: [],
    }).catch(() => null);
    return result ?? null;
  }

  private async setScriptTimeout(): Promise<void> {
    await this.webdriver("POST", `/session/${this.sessionId}/timeouts`, { script: 5000 }).catch(() => undefined);
  }

  private async waitForDriver(timeoutMs = STARTUP_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`http://127.0.0.1:${GECKODRIVER_PORT}/status`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const body = (await response.json()) as { value?: { ready?: boolean } };
          if (body.value?.ready === true) return true;
        }
      } catch {
        // Not ready yet.
      }
      await sleep(300);
    }
    return false;
  }

  private async webdriver<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${GECKODRIVER_PORT}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const parsed = (await response.json().catch(() => null)) as WebDriverResponse<T> | null;
      if (!response.ok || !parsed) {
        const message = (parsed?.value as { message?: string } | undefined)?.message ?? "webdriver_error";
        throw new Error(message);
      }
      return parsed.value;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Connects to the session's BiDi WebSocket and subscribes to log events
   * (always) and network events (best-effort: only when the pinned Firefox
   * version exposes them). Every event is sanitized before it is re-emitted.
   */
  private async connectBidi(webSocketUrl: string | undefined): Promise<void> {
    if (!webSocketUrl) return;
    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => {
      addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
      send(data: string): void;
      close(): void;
    } }).WebSocket;
    if (!WebSocketCtor) return;

    const socket = new WebSocketCtor(webSocketUrl);
    this.bidiSocket = socket;
    const pending = new Map<number, () => void>();

    await new Promise<void>((resolve) => {
      const openHandler = (): void => resolve();
      socket.addEventListener("open", openHandler);
      socket.addEventListener("error", openHandler);
      setTimeout(() => resolve(), 5000).unref?.();
    });

    const sendCommand = (method: string, params: Record<string, unknown>, tolerant: boolean): Promise<void> => {
      return new Promise((resolve) => {
        const id = this.nextBidiId++;
        pending.set(id, () => resolve());
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch {
          pending.delete(id);
          if (!tolerant) resolve();
          return;
        }
        setTimeout(() => {
          if (pending.delete(id)) resolve();
        }, 3000).unref?.();
      });
    };

    socket.addEventListener("message", (event) => {
      let message: BidiMessage;
      try {
        message = JSON.parse(String(event.data)) as BidiMessage;
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        pending.get(message.id)?.();
        pending.delete(message.id);
        return;
      }
      if (message.method) {
        this.handleBidiEvent(message.method, message.params ?? {});
      }
    });

    await sendCommand("session.subscribe", { events: ["log.entryAdded"] }, true);
    // Network events are version-dependent in Firefox; failure is expected and
    // silently ignored (capability metadata already reports them as partial).
    await sendCommand(
      "session.subscribe",
      { events: ["network.beforeRequestSent", "network.responseCompleted"] },
      true,
    );
  }

  private handleBidiEvent(method: string, params: Record<string, unknown>): void {
    if (method === "log.entryAdded") {
      const level = String(params.level ?? "info");
      const text = sanitizeText(String(params.text ?? ""));
      if (!text) return;
      const mapped =
        level === "error" ? "error" : level === "warning" ? "warning" : level === "info" || level === "debug" ? "info" : "log";
      if (mapped === "error") {
        this.events.emit({ type: "error", level: "error", source: "page", message: text });
      } else {
        this.events.emit({ type: "console", level: mapped, source: "page", message: text });
      }
      return;
    }

    if (method === "network.beforeRequestSent") {
      const request = (params.request as { request?: string; method?: string } | undefined)?.request;
      const url = typeof request === "string" ? request : "";
      if (!url) return;
      const methodHttp = String((params.request as { method?: string } | undefined)?.method ?? "GET");
      this.events.emit({
        type: "network",
        level: "info",
        source: "network",
        message: `${methodHttp} ${redactUrl(url)}`,
        metadata: { method: methodHttp, url: redactUrl(url), resourceType: "network" },
      });
      return;
    }

    if (method === "network.responseCompleted") {
      const response = params.response as { url?: string; status?: number } | undefined;
      const url = response?.url ?? "";
      const status = typeof response?.status === "number" ? response.status : null;
      if (!url || status === null) return;
      this.events.emit({
        type: "network",
        level: status >= 400 ? "warning" : "info",
        source: "network",
        message: `${status} ${redactUrl(url)}`,
        metadata: { method: "RESPONSE", url: redactUrl(url), status, resourceType: "network" },
      });
    }
  }
}

export function createFirefoxBrowser(options: BrowserAdapterOptions): SandboxBrowser {
  return new GeckoBrowser(options.events);
}
