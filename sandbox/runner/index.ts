import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventHub } from "./events";
import { createSandboxBrowser, type SandboxBrowser } from "./browsers";
import { isSandboxBrowserId } from "./browsers/types";
import type { InteractiveInputAction } from "./browsers/types";
import { startTestPageServer } from "./test-page";
import { cleanupRuntimeDirectories } from "./cleanup";
import { DEFAULT_TEST_PAGE_URL, validatePublicUrl } from "./security";

type SandboxStatus = "idle" | "starting" | "running" | "stopped" | "failed";

const TOKEN = process.env.RUNNER_TOKEN || "";
const ALLOWED_ACTIONS = new Set([
  "start",
  "stop",
  "reload",
  "open-url",
  "restart-extension",
  "clear-console",
  // Phase 11 interactive commands (validated below; no protocol passthrough).
  "go-back",
  "go-forward",
  "set-viewport",
  "input",
  "open-popup",
  "close-popup",
  "get-url",
]);
const ALLOWED_TEST_ACTIONS = new Set(["open_url", "reload_page", "wait", "click", "type", "select", "scroll", "inspect_text", "inspect_element", "open_popup", "clear_console", "capture_screenshot"]);

/** Independent runner-side input allowlist (the host validates separately). */
const RUNNER_INPUT_TYPES = new Set([
  "pointer_move",
  "pointer_down",
  "pointer_up",
  "click",
  "double_click",
  "type_text",
  "key_press",
  "scroll",
]);
const RUNNER_ALLOWED_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Space",
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
]);
const VIEWPORT_MIN_WIDTH = 320;
const VIEWPORT_MAX_WIDTH = 3840;
const VIEWPORT_MIN_HEIGHT = 240;
const VIEWPORT_MAX_HEIGHT = 2160;

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

/** Validates one interactive input action with the runner's own allowlist. */
function validateInteractiveInput(raw: unknown): { ok: true; action: InteractiveInputAction } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "An input action object is required." };
  const action = raw as Record<string, unknown>;
  if (typeof action.type !== "string" || !RUNNER_INPUT_TYPES.has(action.type)) {
    return { ok: false, reason: "Unsupported input action." };
  }
  const target = action.target === undefined || action.target === "page" ? "page" : action.target === "popup" ? "popup" : null;
  if (target === null) return { ok: false, reason: "Invalid input target." };
  const viewport = target === "popup"
    ? { width: 3840, height: 2160 }
    : browser.currentViewport?.() ?? { width: VIEWPORT_MAX_WIDTH, height: VIEWPORT_MAX_HEIGHT };
  const needsCoords = ["pointer_move", "pointer_down", "pointer_up", "click", "double_click", "scroll"].includes(action.type);
  if (needsCoords) {
    const x = Math.round(Number(action.x));
    const y = Math.round(Number(action.y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
      return { ok: false, reason: "Coordinates are outside the viewport." };
    }
  }
  if (action.type === "type_text" && (!isSafeString(action.text, 2000) || typeof action.text !== "string")) {
    return { ok: false, reason: "Text is too long or invalid." };
  }
  if (action.type === "key_press" && (typeof action.key !== "string" || !RUNNER_ALLOWED_KEYS.has(action.key))) {
    return { ok: false, reason: "This key is not supported." };
  }
  if (action.type === "scroll") {
    for (const delta of [action.deltaX, action.deltaY]) {
      const value = Number(delta);
      if (!Number.isFinite(value) || Math.abs(value) > 3000) {
        return { ok: false, reason: "Scroll delta is out of range." };
      }
    }
  }
  if (action.button !== undefined && action.button !== "left" && action.button !== "right") {
    return { ok: false, reason: "Unsupported mouse button." };
  }
  return { ok: true, action: action as unknown as InteractiveInputAction };
}

/** Safe relative popup path inside the extension directory (no traversal). */
function isSafePopupPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9._\-\/]*\.html?$/i.test(value) &&
    !value.includes("..")
  );
}

function unsupported(kind: string): { ok: boolean; status: string; message: string } {
  events.emit({
    type: "extension",
    level: "warning",
    source: "extension",
    message: `${kind} is not supported by this browser runtime.`,
  });
  return { ok: false, status, message: `${kind} is not supported by this browser runtime.` };
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

async function handleCommand(body: unknown): Promise<{ ok: boolean; status: string; message?: string; data?: Record<string, unknown> }> {
  const parsed = body as { command?: string; payload?: { url?: string; width?: number; height?: number; action?: unknown; popupPath?: string; testUrl?: string } };
  const command = parsed?.command;
  if (!command || !ALLOWED_ACTIONS.has(command)) {
    return { ok: false, status, message: "Unsupported command." };
  }

  switch (command) {
    case "start": {
      status = "starting";
      events.emit({ type: "sandbox", level: "info", source: "runner", message: "Starting sandbox." });
      // Optional initial URL: validated with the same public-URL policy. When
      // absent the browser opens about:blank (never an internal page).
      let startUrl = "about:blank";
      const requestedUrl = typeof parsed?.payload?.testUrl === "string" ? parsed.payload.testUrl : undefined;
      if (requestedUrl) {
        const validated = validatePublicUrl(requestedUrl);
        if (!validated.ok) return { ok: false, status, message: validated.reason ?? "URL blocked." };
        startUrl = validated.url;
      }
      const ok = await browser.start("/tmp/extension", startUrl);
      if (!ok) {
        status = "failed";
        return { ok: false, status, message: "Browser startup failed." };
      }
      // Real extension-load evidence gates "running": the host only marks the
      // session READY when this succeeds.
      let evidence = "none";
      if (browser.verifyExtensionLoaded) {
        const verified = await browser.verifyExtensionLoaded(12000);
        evidence = verified.evidence;
        if (!verified.loaded) {
          status = "failed";
          events.emit({ type: "extension", level: "error", source: "extension", message: "The extension did not load in the isolated browser." });
          await browser.stop();
          return { ok: false, status, message: "The extension did not load in the isolated browser." };
        }
      }
      status = "running";
      events.emit({ type: "sandbox", level: "info", source: "runner", message: "Sandbox ready." });
      return {
        ok: true,
        status,
        data: {
          evidence,
          browserVersion: typeof browser.getBrowserVersion === "function" ? browser.getBrowserVersion() : null,
        },
      };
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
    case "go-back": {
      if (!browser.goBack) return unsupported("Back navigation");
      const result = await browser.goBack();
      return { ok: result.ok, status, message: result.message, data: result.data };
    }
    case "go-forward": {
      if (!browser.goForward) return unsupported("Forward navigation");
      const result = await browser.goForward();
      return { ok: result.ok, status, message: result.message, data: result.data };
    }
    case "set-viewport": {
      if (!browser.setViewport) return unsupported("Viewport changes");
      const width = Math.round(Number(parsed?.payload?.width));
      const height = Math.round(Number(parsed?.payload?.height));
      if (
        !Number.isInteger(width) || !Number.isInteger(height) ||
        width < VIEWPORT_MIN_WIDTH || width > VIEWPORT_MAX_WIDTH ||
        height < VIEWPORT_MIN_HEIGHT || height > VIEWPORT_MAX_HEIGHT
      ) {
        return { ok: false, status, message: "Viewport dimensions are out of range." };
      }
      const result = await browser.setViewport(width, height);
      return { ok: result.ok, status, message: result.message, data: result.data };
    }
    case "input": {
      if (!browser.dispatchInput) return unsupported("Interactive input");
      const validated = validateInteractiveInput(parsed?.payload?.action);
      if (!validated.ok) return { ok: false, status, message: validated.reason };
      const result = await browser.dispatchInput(validated.action);
      return { ok: result.ok, status, message: result.message, data: result.data };
    }
    case "open-popup": {
      if (!browser.openPopup) return unsupported("Popup testing");
      const popupPath = parsed?.payload?.popupPath;
      if (!isSafePopupPath(popupPath)) {
        return { ok: false, status, message: "Popup path is invalid." };
      }
      const result = await browser.openPopup(popupPath);
      return { ok: result.ok, status, message: result.message, data: result.data };
    }
    case "close-popup": {
      if (!browser.closePopup) return unsupported("Popup testing");
      const result = await browser.closePopup();
      return { ok: result.ok, status, message: result.message };
    }
    case "get-url": {
      const url = await browser.getPageUrl();
      return { ok: true, status, data: { url } };
    }
    case "reload":
      await browser.reload();
      return { ok: true, status };
    case "restart-extension": {
      if (browser.restartExtension) {
        const result = await browser.restartExtension();
        return { ok: result.ok, status, message: result.message };
      }
      if (browserId === "firefox") {
        // Temporary add-ons cannot be restarted in place in this runtime;
        // report the limitation honestly instead of pretending to restart.
        events.emit({ type: "extension", level: "warning", source: "extension", message: "Extension restart is not supported by the Firefox runtime." });
        return { ok: false, status, message: "Extension restart is not supported by the Firefox runtime." };
      }
      events.emit({ type: "extension", level: "info", source: "extension", message: "Extension restart requested." });
      await browser.reload();
      return { ok: true, status };
    }
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
    const target = url.searchParams.get("target") === "popup" ? "popup" : "page";
    void (async () => {
      const png =
        target === "popup" && browser.capturePopupScreenshot
          ? await browser.capturePopupScreenshot()
          : await browser.captureScreenshot();
      if (!png) {
        sendJson(response, 409, { error: target === "popup" ? "Popup screenshot not available." : "Screenshot not ready." });
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
