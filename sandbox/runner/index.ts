import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventHub } from "./events";
import { BrowserRunner } from "./browser";
import { startTestPageServer } from "./test-page";
import { cleanupRuntimeDirectories } from "./cleanup";
import { DEFAULT_TEST_PAGE_URL, validatePublicUrl } from "./security";

type SandboxStatus = "idle" | "starting" | "running" | "stopped" | "failed";

const TOKEN = process.env.RUNNER_TOKEN || "";
const ALLOWED_ACTIONS = new Set(["start", "stop", "reload", "open-url", "restart-extension", "clear-console"]);

const events = new EventHub();
const browser = new BrowserRunner(events);
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
    sendJson(response, 200, { ok: true, status });
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
