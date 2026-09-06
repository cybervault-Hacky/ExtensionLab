import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_KEYS,
  MAX_SCROLL_DELTA,
  MAX_TYPE_TEXT_LENGTH,
  MAX_URL_INPUT_LENGTH,
  inputPayloadWithinLimit,
  validateInputAction,
  validateViewport,
} from "@/lib/interactive/limits";
import {
  keepaliveSession,
  navigateSession,
  sendInput,
  setSessionViewport,
  stopInteractiveSession,
} from "@/lib/interactive/service";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { AppError } from "@/lib/observability/errors";
import { FakeDriver, makeUser, setupHarness, startReadySession, type Harness } from "./helpers";

/**
 * Input-model and URL-policy security: every client-supplied command is
 * validated against typed allowlists before it can reach the isolated runner,
 * and navigation reuses the Phase 3 SSRF guard unchanged.
 */

let harness: Harness;
let driver: FakeDriver;

beforeEach(() => {
  harness = setupHarness();
  driver = new FakeDriver();
});
afterEach(() => harness.teardown());

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`Expected an AppError with code ${code}, but the call succeeded.`);
}

describe("input model validation", () => {
  const viewport = { width: 1280, height: 800 };

  it("accepts every allowlisted action type with well-formed payloads", () => {
    expect(validateInputAction({ type: "pointer_move", x: 10, y: 20 }, viewport)).toMatchObject({
      ok: true,
      action: { type: "pointer_move", x: 10, y: 20 },
    });
    expect(validateInputAction({ type: "click", x: 0, y: 0 }, viewport)).toMatchObject({ ok: true });
    expect(validateInputAction({ type: "double_click", x: 1280, y: 800 }, viewport)).toMatchObject({ ok: true });
    expect(validateInputAction({ type: "pointer_down", x: 5, y: 6, button: "right" }, viewport)).toMatchObject({
      ok: true,
      action: { button: "right" },
    });
    expect(validateInputAction({ type: "pointer_up", x: 5, y: 6 }, viewport)).toMatchObject({ ok: true });
    expect(validateInputAction({ type: "type_text", text: "hello" }, viewport)).toMatchObject({ ok: true });
    expect(validateInputAction({ type: "key_press", key: "Enter" }, viewport)).toMatchObject({ ok: true });
    expect(validateInputAction({ type: "scroll", x: 400, y: 400, deltaX: -120, deltaY: 800 }, viewport)).toMatchObject({
      ok: true,
    });
    expect(validateInputAction({ type: "click", x: 3, y: 4, target: "popup" }, viewport)).toMatchObject({
      ok: true,
      action: { target: "popup" },
    });
  });

  it("rejects unknown action types, unknown fields, and non-objects", () => {
    expect(validateInputAction({ type: "eval", script: "process.exit(1)" }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "cdp", sessionId: 1, method: "*" }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "click", x: 1, y: 1, modifiers: { meta: true } }, viewport).ok).toBe(false);
    expect(validateInputAction("click", viewport).ok).toBe(false);
    expect(validateInputAction(null, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "shell", cmd: "cat /etc/passwd" }, viewport).ok).toBe(false);
  });

  it("clamps coordinates to the session viewport", () => {
    expect(validateInputAction({ type: "click", x: -1, y: 10 }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "click", x: 10, y: -1 }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "click", x: 1281, y: 10 }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "click", x: 10, y: 801 }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "pointer_move", x: NaN, y: 10 }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "pointer_move", x: "10", y: 10 }, viewport).ok).toBe(false);
  });

  it("bounds typing, keys, buttons, and scroll deltas", () => {
    expect(validateInputAction({ type: "type_text", text: "a".repeat(MAX_TYPE_TEXT_LENGTH + 1) }, viewport).ok).toBe(
      false,
    );
    expect(validateInputAction({ type: "type_text" }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "key_press", key: "F13" }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "key_press", key: "Meta" }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "key_press", key: "Control" }, viewport).ok).toBe(false);
    expect(validateInputAction({ type: "pointer_down", x: 1, y: 1, button: "middle" }, viewport).ok).toBe(false);
    expect(
      validateInputAction({ type: "scroll", x: 1, y: 1, deltaX: MAX_SCROLL_DELTA + 1, deltaY: 0 }, viewport).ok,
    ).toBe(false);
    expect(
      validateInputAction({ type: "scroll", x: 1, y: 1, deltaX: 0, deltaY: -MAX_SCROLL_DELTA - 1 }, viewport).ok,
    ).toBe(false);
    expect(ALLOWED_KEYS).toContain("Enter");
    expect(ALLOWED_KEYS).not.toContain("Meta");
  });

  it("enforces the raw input payload byte limit", () => {
    expect(inputPayloadWithinLimit({ action: { type: "type_text", text: "ok" } })).toBe(true);
    expect(inputPayloadWithinLimit({ action: { type: "type_text", text: "a".repeat(64 * 1024) } })).toBe(false);
  });

  it("validates viewport changes against deployment bounds", () => {
    expect(validateViewport(1280, 800)).toMatchObject({ ok: true, width: 1280, height: 800 });
    expect(validateViewport(100, 800).ok).toBe(false);
    expect(validateViewport(4096, 800).ok).toBe(false);
    expect(validateViewport(1280.5, 800).ok).toBe(false);
    expect(validateViewport("1280", 800).ok).toBe(false);
  });
});

describe("input commands against the isolated runner", () => {
  it("forwards only validated actions to the runner", async () => {
    const { user, sessionId, runner } = await startReadySession(driver);
    await sendInput(user.id, sessionId, { type: "click", x: 640, y: 400 });
    expect(runner.inputs).toEqual([{ type: "click", x: 640, y: 400, target: "page" }]);
    expect(getSessionById(sessionId)!.status).toBe("ACTIVE");

    // Rejected actions never reach the runner.
    await expectAppError(sendInput(user.id, sessionId, { type: "eval", script: "1" }), "INPUT_REJECTED");
    await expectAppError(sendInput(user.id, sessionId, { type: "click", x: 99999, y: 0 }), "INPUT_REJECTED");
    await expectAppError(sendInput(user.id, sessionId, { type: "key_press", key: "Meta" }), "INPUT_REJECTED");
    expect(runner.inputs).toHaveLength(1);

    // Rate limit: sliding window eventually pushes back.
    const user2 = makeUser();
    const second = await startReadySession(driver, user2);
    let limited = false;
    for (let i = 0; i < 400 && !limited; i += 1) {
      try {
        await sendInput(user2.id, second.sessionId, { type: "pointer_move", x: 10 + (i % 100), y: 20 });
      } catch (error) {
        expect((error as AppError).code).toBe("RATE_LIMITED");
        limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  it("rejects input for sessions that cannot take commands", async () => {
    const { user, sessionId } = await startReadySession(driver);
    await stopInteractiveSession(user.id, sessionId, driver);
    expect(getSessionById(sessionId)!.status).toBe("STOPPED");
    await expectAppError(sendInput(user.id, sessionId, { type: "click", x: 1, y: 1 }), "SESSION_NOT_READY");
    // Cross-tenant input is a 404-shaped not-found, never a hint.
    const stranger = makeUser();
    await expectAppError(sendInput(stranger.id, sessionId, { type: "click", x: 1, y: 1 }), "BROWSER_SESSION_NOT_FOUND");
  });

  it("applies viewport changes through the runner and records them", async () => {
    const { user, sessionId, runner } = await startReadySession(driver);
    const updated = await setSessionViewport(user.id, sessionId, 1024, 768);
    expect(updated.viewport_width).toBe(1024);
    expect(updated.viewport_height).toBe(768);
    expect(runner.viewport).toEqual({ width: 1024, height: 768 });
    expect(runner.calls.some((call) => call.command === "set-viewport")).toBe(true);
    await expectAppError(setSessionViewport(user.id, sessionId, 3, 3), "INVALID_INPUT");
  });
});

describe("navigation URL policy (SSRF guard reuse)", () => {
  const DANGEROUS_URLS = [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "chrome://extensions",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com",
    "https://user:pass@example.com/",
    "http://localhost:3000/", // plain HTTP + localhost
    "https://localhost/", 
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data/", // cloud metadata
    "https://192.168.1.1/admin",
    "https://10.0.0.5/",
    "https://[::1]/",
    "https://172.20.0.1/",
    `https://example.com/${"a".repeat(MAX_URL_INPUT_LENGTH)}`,
  ];

  it("rejects every dangerous scheme/host before the runner sees it", async () => {
    const { user, sessionId, runner } = await startReadySession(driver);
    for (const url of DANGEROUS_URLS) {
      await expectAppError(navigateSession(user.id, sessionId, { op: "navigate", url }), "UNSAFE_URL");
    }
    // No open-url command may have escaped to the container.
    expect(runner.calls.filter((call) => call.command === "open-url")).toHaveLength(0);
    expect(runner.url).toBe("about:blank");
  });

  it("allows a public https URL and marks the session ACTIVE", async () => {
    const { user, sessionId, runner } = await startReadySession(driver);
    // A public IP literal needs no DNS resolution, keeping the test deterministic.
    const updated = await navigateSession(user.id, sessionId, { op: "navigate", url: "https://93.184.216.34/" });
    expect(updated.status).toBe("ACTIVE");
    expect(updated.current_url).toContain("93.184.216.34");
    expect(runner.calls.some((call) => call.command === "open-url")).toBe(true);

    // Back/forward/reload operations reuse the same guarded channel.
    await navigateSession(user.id, sessionId, { op: "back" });
    await navigateSession(user.id, sessionId, { op: "forward" });
    await navigateSession(user.id, sessionId, { op: "reload" });
    const commands = runner.calls.map((call) => call.command);
    expect(commands).toEqual(expect.arrayContaining(["go-back", "go-forward", "reload"]));
  });

  it("refuses navigation for terminal sessions", async () => {
    const { user, sessionId } = await startReadySession(driver);
    await stopInteractiveSession(user.id, sessionId, driver);
    await expectAppError(navigateSession(user.id, sessionId, { op: "navigate", url: "https://93.184.216.34/" }), "SESSION_NOT_READY");
  });
});

describe("keepalive", () => {
  it("touches activity without ever extending the hard deadline", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const before = getSessionById(sessionId)!;
    const kept = keepaliveSession(user.id, sessionId);
    expect(kept.last_activity_at!).toBeGreaterThanOrEqual(before.last_activity_at ?? 0);
    expect(kept.expires_at).toBe(before.expires_at);
  });
});
