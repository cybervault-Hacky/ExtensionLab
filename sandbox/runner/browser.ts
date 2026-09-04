import { spawn, type ChildProcess } from "node:child_process";
import CDP, { List, type CdpClient, type TargetInfo } from "chrome-remote-interface";
import { EventHub } from "./events";
import { redactUrl, sanitizeText, truncate } from "./security";

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

export class BrowserRunner {
  private process: ChildProcess | null = null;
  private client: CdpClient | null = null;
  private pageTarget: TargetInfo | null = null;
  private started = false;
  private sawServiceWorker = false;
  private readonly port = 9222;

  constructor(private readonly events: EventHub) {}

  async start(extensionPath: string, testUrl: string): Promise<boolean> {
    this.events.emit({ type: "browser", level: "info", source: "browser", message: "Starting isolated Chromium." });

    const args = [
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

    this.process = spawn("xvfb-run", ["-a", "chromium", ...args], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process.on("exit", (code) => {
      this.started = false;
      this.events.emit({ type: "browser", level: "warning", source: "browser", message: `Chromium exited (code ${code ?? "unknown"}).` });
    });

    const alive = await this.waitForCdp();
    if (!alive) {
      this.events.emit({ type: "extension", level: "error", source: "browser", message: "Browser startup failed." });
      return false;
    }

    this.events.emit({ type: "browser", level: "info", source: "browser", message: "Browser started. Loading unpacked extension." });
    await this.openPage(testUrl);
    this.started = true;
    return true;
  }

  async openPage(url: string): Promise<void> {
    if (!this.client || !this.pageTarget) return;
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

  async stop(): Promise<void> {
    this.started = false;
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
      if (versions.length > 0 && !this.sawServiceWorker) {
        this.sawServiceWorker = true;
        this.events.emit({ type: "extension", level: "info", source: "extension", message: "Service worker registered. Extension loaded." });
      }
    });

    client.on("Page.loadEventFired", (params) => {
      const event = params as PageLoadEvent;
      this.events.emit({ type: "page", level: "info", source: "page", message: `Page loaded (frame ${truncate(event.frameId, 24)}).` });
    });
  }
}
