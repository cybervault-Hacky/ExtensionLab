import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  captureFrame,
  captureScreenshotArtifact,
  closePopup,
  getConsoleEntries,
  getNetworkEntries,
  getSessionEventViews,
  listSessionArtifactViews,
  openPopup,
} from "@/lib/interactive/service";
import { GET as streamRoute } from "@/app/api/browser-sessions/[id]/events/stream/route";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { AppError } from "@/lib/observability/errors";
import { sessionCookieFor } from "../phase7/helpers";
import { FakeDriver, makeUser, setupHarness, startReadySession, waitFor, type Harness } from "./helpers";

/**
 * Popup rendering, screenshot capture, and the live workspace stream. The
 * popup always renders INSIDE the isolated container (frames only); console
 * and network observations flow through the hub, never from the client.
 */

let harness: Harness;
let driver: FakeDriver;

beforeEach(() => {
  harness = setupHarness();
  driver = new FakeDriver();
});
afterEach(() => harness.teardown());

describe("extension popup", () => {
  it("opens and closes the popup inside the container and streams its frame", async () => {
    const { user, sessionId } = await startReadySession(driver);

    // Before the popup opens there is no popup frame to fetch.
    expect(await captureFrame(user.id, sessionId, "popup")).toBeNull();

    const opened = await openPopup(user.id, sessionId);
    expect(opened.popup_open).toBe(1);
    expect(opened.popup_width).toBe(380);
    expect(opened.popup_height).toBe(600);
    expect(getSessionEventViews(user.id, sessionId).map((event) => event.type)).toContain("popup_opened");

    // The popup frame now exists — rendered by the container, transported as PNG bytes.
    const frame = await captureFrame(user.id, sessionId, "popup");
    expect(frame).not.toBeNull();
    // 1x1 transparent PNG signature.
    expect(frame!.bytes[0]).toBe(0x89);
    expect(Buffer.from(frame!.bytes.subarray(1, 4)).toString("ascii")).toBe("PNG");

    const closed = await closePopup(user.id, sessionId);
    expect(closed.popup_open).toBe(0);
    expect(closed.popup_width).toBeNull();
    expect(await captureFrame(user.id, sessionId, "popup")).toBeNull();
  });

  it("refuses to open a popup the extension does not declare", async () => {
    const noPopupManifest = JSON.stringify({
      manifest_version: 3,
      name: "No Popup",
      version: "1.0.0",
      background: { service_worker: "background.js" },
    });
    const { user, sessionId } = await startReadySession(driver, makeUser(), noPopupManifest);
    await expect(openPopup(user.id, sessionId)).rejects.toMatchObject({ code: "POPUP_UNAVAILABLE" } satisfies Partial<AppError>);
    expect(getSessionById(sessionId)!.popup_open).toBe(0);
  });

  it("fails gracefully when the popup page fails to load in the container", async () => {
    const { user, sessionId, runner } = await startReadySession(driver);
    (runner as unknown as { options: { popupSupported?: boolean } }).options = { popupSupported: false };
    await expect(openPopup(user.id, sessionId)).rejects.toMatchObject({ code: "POPUP_UNAVAILABLE" });
    expect(getSessionEventViews(user.id, sessionId).map((event) => event.type)).toContain("runtime_error");
  });

  it("keeps popup input coordinates inside the popup viewport", async () => {
    const { user, sessionId } = await startReadySession(driver);
    await openPopup(user.id, sessionId);
    const { sendInput } = await import("@/lib/interactive/service");
    await sendInput(user.id, sessionId, { type: "click", x: 100, y: 100, target: "popup" });
    await expect(
      sendInput(user.id, sessionId, { type: "click", x: 5000, y: 100, target: "popup" }),
    ).rejects.toMatchObject({ code: "INPUT_REJECTED" });
  });
});

describe("console and network observation through the hub", () => {
  it("collects runner console and network events in bounded rings", async () => {
    const { user, sessionId, runner } = await startReadySession(driver);
    // First consumer read attaches the hub to the runner's event stream;
    // events emitted before the attach are not replayed by the runner.
    getConsoleEntries(user.id, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    runner.emitConsole("hello from the page", "log");
    runner.emitNetwork("https://93.184.216.34/lib.js", 200);

    const consoleEntries = await waitFor(
      () => (getConsoleEntries(user.id, sessionId).entries.find((entry) => entry.message === "hello from the page") ?? null),
      5000,
      "console entry in hub",
    );
    expect(consoleEntries.level).toBe("log");

    const networkEntries = await waitFor(
      () => (getNetworkEntries(user.id, sessionId).entries.find((entry) => entry.url === "https://93.184.216.34/lib.js") ?? null),
      5000,
      "network entry in hub",
    );
    expect(networkEntries.status).toBe(200);

    // The ring is bounded: flooding it cannot grow memory without limit.
    for (let i = 0; i < 420; i += 1) runner.emitConsole(`spam ${i}`, "log");
    await waitFor(() => (getConsoleEntries(user.id, sessionId).entries.length ? getConsoleEntries(user.id, sessionId).entries : null), 5000, "any entries");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(getConsoleEntries(user.id, sessionId).entries.length).toBeLessThanOrEqual(300);
  });
});

describe("screenshot artifacts", () => {
  it("captures retained artifacts with integrity metadata and retention", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const artifact = await captureScreenshotArtifact(user.id, sessionId, "evidence");
    expect(artifact.label).toBe("evidence");
    expect(artifact.url).toBe(`/api/browser-sessions/${sessionId}/artifacts/${artifact.id}`);
    expect(listSessionArtifactViews(user.id, sessionId).map((view) => view.id)).toContain(artifact.id);
    expect(artifact.expiresAt).toBeGreaterThan(Date.now());
    expect(getSessionEventViews(user.id, sessionId).map((event) => event.type)).toContain("screenshot_captured");
  });

  it("enforces the per-session artifact cap", async () => {
    harness.teardown();
    harness = setupHarness({ INTERACTIVE_BROWSER_MAX_ARTIFACTS: "1" });
    driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    await captureScreenshotArtifact(user.id, sessionId, null);
    await expect(captureScreenshotArtifact(user.id, sessionId, null)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });
});

describe("workspace event stream (SSE)", () => {
  function sseRequest(userId: string, sessionId: string, signal: AbortSignal): NextRequest {
    return new NextRequest(`http://localhost:3000/api/browser-sessions/${sessionId}/events/stream`, {
      method: "GET",
      headers: { host: "localhost:3000", cookie: sessionCookieFor(userId) },
      signal,
    });
  }

  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (accumulated: string) => boolean,
    timeoutMs = 5000,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE read timeout")), deadline - Date.now())),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (predicate(text)) return text;
    }
    throw new Error(`SSE stream never matched: ${text.slice(0, 400)}`);
  }

  it("replays a snapshot (state/console/network/events) then streams live frames", async () => {
    const { user, sessionId, runner } = await startReadySession(driver);

    const controller = new AbortController();
    const response = await streamRoute(sseRequest(user.id, sessionId, controller.signal), {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    try {
      // Snapshot replay arrives first.
      const snapshot = await readUntil(reader, (text) => text.includes("event: state") && text.includes("event: events"));
      expect(snapshot).toContain("event: console");
      expect(snapshot).toContain("event: network");

      // Live frames continue to arrive from the container event stream.
      // (The hub attached while the snapshot was being read.)
      await new Promise((resolve) => setTimeout(resolve, 250));
      runner.emitConsole("streamed-live", "log");
      await readUntil(reader, (text) => text.includes("streamed-live"));
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it("never serves another user's session stream", async () => {
    const { sessionId } = await startReadySession(driver);
    const stranger = makeUser();
    const controller = new AbortController();
    const response = await streamRoute(sseRequest(stranger.id, sessionId, controller.signal), {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(response.status).toBe(404);
    controller.abort();
  });
});
