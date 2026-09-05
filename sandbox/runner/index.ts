import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventHub } from "./events";
import { createSandboxBrowser, type SandboxBrowser } from "./browsers";
import { isSandboxBrowserId } from "./browsers/types";
import { startTestPageServer } from "./test-page";
import { cleanupRuntimeDirectories } from "./cleanup";
import { DEFAULT_TEST_PAGE_URL, validatePublicUrl } from "./security";

type SandboxStatus = "idle" | "starting" | "running" | "stopped" | "failed";

const TOKEN = process.env.RUNNER_TOKEN || "";
const ALLOWED_ACTIONS = new Set(["start", "stop", "reload", "open-url", "restart-extension", "clear-console"]);
const ALLOWED_TEST_ACTIONS = new Set(["open_url", "reload_page", "wait", "click", "type", "select", "scroll", "inspect_text", "inspect_element", "open_popup", "clear_console", "capture_screenshot"]);

const events = new EventHub();
// The browser runtime is fixed by the container image/ENV — never by requests.
const browserId = isSandboxBrowserId(process.env.EXTENSIONLAB_BROWSER) ? process.env.EXTENSIONLAB_BROWSER : "chromium";
const browser: SandboxBrowser = createSandboxBrowser(browserId, events);
let status: SandboxStatus = "idle";
let defaultPage = DEFAULT_TEST_PAGE_URL;

function authorize(request: IncomingMessage): boolean {
  return TOKEN !== "" && request.headers["x-sandbox-token"] === TOKEN;
}

function sendJson(response: ServerResponse, code: number, payload: unknown): void {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 64 * 1024) {
        request.destroy();
        reject(new Error("Body too large."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

interface SafeTestActionInput {
  type: string;
  selector?: string;
  value?: string;
  milliseconds?: number;
  url?: string;
}

function isSafeString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

async function handleTestAction(input: SafeTestActionInput): Promise<{ ok: boolean; status: string; data?: unknown; message?: string }> {
  if (!input || !ALLOWED_TEST_ACTIONS.has(input.type)) {
    return { ok: false, status, message: "Unsupported test action." };
  }

  if (input.selector && (!isSafeString(input.selector, 200) || /[^\w\s#@.,\-\[\]="'":]/.test(input.selector))) {
    return { ok: false, status, message: "Selector is not safe." };
  }
  if (input.value && input.value.length > 4000) {
    return { ok: false, status, message: "Action value is too long." };
  }
  if (input.url && input.url.length > 2048) {
    return { ok: false, status, message: "URL is too long." };
  }

  switch (input.type) {
    case "open_url": {
      if (!input.url) return { ok: false, status, message: "URL is required." };
      const validated = validatePublicUrl(input.url);
      if (!validated.ok) return { ok: false, status, message: validated.reason ?? "URL blocked." };
      await browser.openPage(validated.url);
      return { ok: true, status, data: { url: validated.url } };
    }
    case "reload_page":
      await browser.reload();
      return { ok: true, status };
    case "wait": {
      const ms = Math.min(Math.max(0, Number(input.milliseconds ?? 0)), 5000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { ok: true, status, data: { waited: ms } };
    }
    case "click": {
      if (!input.selector) return { ok: false, status, message: "Selector is required." };
      const clicked = await browser.click(input.selector);
      return { ok: clicked, status, data: { clicked }, message: clicked ? "Element clicked." : "Element not found." };
    }
    case "type": {
      if (!input.selector) return { ok: false, status, message: "Selector is required." };
      const typed = await browser.type(input.selector, input.value ?? "");
      return { ok: typed, status, data: { typed }, message: typed ? "Value entered." : "Element not found." };
    }
    case "select": {
      if (!input.selector) return { ok: false, status, message: "Selector is required." };
      const selected = await browser.select(input.selector, input.value ?? "");
      return { ok: selected, status, data: { selected }, message: selected ? "Selection applied." : "Element not found." };
    }
    case "scroll": {
      if (!input.selector) return { ok: false, status, message: "Selector is required." };
      const scrolled = await browser.scroll(input.selector);
      return { ok: scrolled, status, data: { scrolled } };
    }
    case "inspect_text": {
      if (!input.selector) return { ok: false, status, message: "Selector is required." };
      const text = await browser.inspectText(input.selector);
      return { ok: true, status, data: { text } };
    }
    case "inspect_element": {
      if (!input.selector) return { ok: false, status, message: "Selector is required." };
      const inspect = await browser.inspectElement(input.selector);
      return { ok: true, status, data: inspect };
    }
    case "open_popup": {
      events.emit({ type: "extension", level: "warning", source: "extension", message: "Popup testing is not supported by this browser environment." });
      return { ok: false, status, message: "Popup testing is not supported by this browser environment." };
    }
    case "clear_console":
      events.emit({ type: "sandbox", level: "info", source: "runner", message: "Console cleared." });
      return { ok: true, status };
    case "capture_screenshot": {
      const png = await browser.captureScreenshot();
      if (!png) return { ok: false, status, message: "Screenshot unavailable." };
      return { ok: true, status, data: { screenshot: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } };
    }
    default:
      return { ok: false, status, message: "Unsupported test action." };
  }
}

async function handleCommand(body: unknown): Promise<{ ok: boolean; status: string; message?: string }> {
  const parsed = body as { command?: string; payload?: { url?: string } };
  const command = parsed?.command;
  if (!command || !ALLOWED_ACTIONS.has(command)) {
    return { ok: false, status, message: "Unsupported command." };
  }

  switch (command) {
    case "start": {
      status = "starting";
      events.emit({ type: "sandbox", level: "info", source: "runner", message: "Starting sandbox." });
      const ok = await browser.start("/tmp/extension", defaultPage);
      if (!ok) {
        status = "failed";
        return { ok: false, status, message: "Browser startup failed." };
      }
      status = "running";
      events.emit({ type: "sandbox", level: "info", source: "runner", message: "Sandbox ready." });
      return { ok: true, status };
    }
    case "open-url": {
      const url = parsed?.payload?.url ?? "";
      const validated = validatePublicUrl(url);
      if (!validated.ok) {
        return { ok: false, status, message: validated.reason ?? "URL blocked." };
      }
      defaultPage = validated.url;
      await browser.openPage(defaultPage);
      return { ok: true, status };
    }
    case "reload":
      await browser.reload();
      return { ok: true, status };
    case "restart-extension":
      if (browserId === "firefox") {
        // Temporary add-ons cannot be restarted in place in this runtime;
        // report the limitation honestly instead of pretending to restart.
        events.emit({ type: "extension", level: "warning", source: "extension", message: "Extension restart is not supported by the Firefox runtime." });
        return { ok: false, status, message: "Extension restart is not supported by the Firefox runtime." };
      }
      events.emit({ type: "extension", level: "info", source: "extension", message: "Extension restart requested." });
      await browser.reload();
      return { ok: true, status };
    case "clear-console":
      events.emit({ type: "sandbox", level: "info", source: "runner", message: "Console cleared." });
      return { ok: true, status };
    case "stop":
      status = "stopped";
      await browser.stop();
      events.emit({ type: "sandbox", level: "info", source: "runner", message: "Sandbox stopped." });
      return { ok: true, status };
    default:
      return { ok: false, status, message: "Unsupported command." };
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    // Browser product/version only — never paths, container ids or hosts.
    sendJson(response, 200, { ok: true, status, browser: { id: browserId } });
    return;
  }

  if (!authorize(request)) {
    sendJson(response, 401, { error: "Unauthorized." });
    return;
  }

  if (request.method === "POST" && url.pathname === "/command") {
    void (async () => {
      try {
        const bodyText = await readBody(request);
        const result = await handleCommand(JSON.parse(bodyText));
        sendJson(response, result.ok ? 200 : 400, result);
      } catch {
        sendJson(response, 400, { ok: false, status, message: "Invalid command." });
      }
    })();
    return;
  }

  if (request.method === "POST" && url.pathname === "/action") {
    void (async () => {
      try {
        const bodyText = await readBody(request);
        const action = JSON.parse(bodyText) as SafeTestActionInput;
        const result = await handleTestAction(action);
        sendJson(response, result.ok ? 200 : 400, result);
      } catch {
        sendJson(response, 400, { ok: false, status, message: "Invalid test action." });
      }
    })();
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const unsubscribe = events.subscribe((event) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.on("close", () => unsubscribe());
    return;
  }

  if (request.method === "GET" && url.pathname === "/screenshot") {
    void (async () => {
      const png = await browser.captureScreenshot();
      if (!png) {
        sendJson(response, 409, { error: "Screenshot not ready." });
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      response.end(Buffer.from(png));
    })();
    return;
  }

  sendJson(response, 404, { error: "Not found." });
});

async function main(): Promise<void> {
  events.emit({ type: "sandbox", level: "info", source: "runner", message: "Runner listening." });
  server.listen(9333, "127.0.0.1");
  startTestPageServer();

  const shutdown = async (): Promise<void> => {
    await browser.stop().catch(() => undefined);
    await cleanupRuntimeDirectories();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main();
