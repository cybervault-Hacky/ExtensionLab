import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/observability/errors";
import {
  clearBrowserStateSession,
  inspectSessionElement,
  restartBrowserSession,
  stopInteractiveSession,
  toSessionView,
} from "@/lib/interactive/service";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { listSessionEvents } from "@/lib/db/repositories/browser-sessions";
import { FakeDriver, setupPhase12Harness, startReadySession, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase12Harness();
});

afterEach(() => {
  harness.teardown();
});

describe("Phase 12 §57: element inspection", () => {
  it("returns bounded, sanitized element metadata with a safe selector", async () => {
    const driver = new FakeDriver();
    const { user, sessionId, runner } = await startReadySession(driver);
    const view = await inspectSessionElement(user.id, sessionId, 40, 20, "page");
    expect(view.exists).toBe(true);
    expect(view.tag).toBe("button");
    expect(view.id).toBe("login");
    expect(view.classes).toEqual(["btn", "primary"]);
    expect(view.attributes).toEqual([
      { name: "type", value: "submit" },
      { name: "aria-label", value: "Sign in" },
    ]);
    expect(view.suggestedSelector).toMatch(/^#login$/);
    // The runner received rounded coordinates and the page target.
    const call = runner.calls.find((entry) => entry.command === "inspect-at");
    expect(call?.payload).toMatchObject({ x: 40, y: 20, target: "page" });
  });

  it("reports missing elements honestly (exists: false, no selector)", async () => {
    const driver = new FakeDriver({ inspectResults: [null] });
    const { user, sessionId } = await startReadySession(driver);
    const view = await inspectSessionElement(user.id, sessionId, 5, 5, "page");
    expect(view.exists).toBe(false);
    expect(view.suggestedSelector).toBeNull();
  });

  it("redacts password fields (text preview and value attribute)", async () => {
    const driver = new FakeDriver({
      inspectResults: [
        {
          exists: true,
          tag: "input",
          id: "secret",
          classes: [],
          attributes: [
            { name: "type", value: "password" },
            { name: "value", value: "hunter2-not-real" },
          ],
          textPreview: "hunter2-not-real",
          isPassword: true,
          visible: true,
          rect: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
    });
    const { user, sessionId } = await startReadySession(driver);
    const view = await inspectSessionElement(user.id, sessionId, 10, 10, "page");
    expect(view.isPassword).toBe(true);
    expect(view.textPreview).toBe("[redacted]");
    const value = view.attributes.find((attribute) => attribute.name === "value");
    expect(value?.value).toBe("[redacted]");
  });

  it("rejects coordinates outside the viewport", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    await expect(inspectSessionElement(user.id, sessionId, 5000, 10, "page")).rejects.toMatchObject({
      code: "INPUT_REJECTED",
    });
  });

  it("refuses inspection once the session has ended", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    await stopInteractiveSession(user.id, sessionId, driver);
    await expect(inspectSessionElement(user.id, sessionId, 10, 10, "page")).rejects.toBeInstanceOf(AppError);
  });
});

describe("Phase 12 §57: controlled browser restart (same session identity)", () => {
  it("restarts against the re-verified package binding and records evidence", async () => {
    const driver = new FakeDriver();
    const { user, sessionId, runner } = await startReadySession(driver);
    const restarted = await restartBrowserSession(user.id, sessionId);
    expect(restarted.status).toBe("READY");
    expect(restarted.state_reason).toContain("restarted");
    expect(runner.calls.some((entry) => entry.command === "restart-browser")).toBe(true);
    const events = listSessionEvents(sessionId);
    const restartedEvent = events.find((event) => event.type === "browser_restarted");
    expect(restartedEvent?.metadata_json ?? "").toContain("background-context");
    expect(events.some((event) => event.type === "browser_restart_requested")).toBe(true);
    // Same logical session: id unchanged, extension binding unchanged.
    expect(restarted.id).toBe(sessionId);
    expect(restarted.package_sha256).toBe(getSessionById(sessionId)!.package_sha256);
  });

  it("fails the session honestly when the browser cannot restart", async () => {
    const driver = new FakeDriver({ restartResult: { ok: false, message: "boom" } });
    const { user, sessionId } = await startReadySession(driver);
    await expect(restartBrowserSession(user.id, sessionId)).rejects.toMatchObject({
      code: "BROWSER_SESSION_START_FAILED",
    });
    const row = getSessionById(sessionId)!;
    expect(row.status).toBe("FAILED");
    expect(row.stop_reason).toBe("browser_start_failed");
    // Honest failure classification surfaces in the public view.
    const view = toSessionView(row);
    expect(view.extensionRuntimeStatus).toBe("ERROR");
    expect(view.failureKind).toBe("extension_load_failed");
  });
});

describe("Phase 12 §57: disposable-browser state clearing", () => {
  it("clears container-scoped state only and records the event", async () => {
    const driver = new FakeDriver();
    const { user, sessionId, runner } = await startReadySession(driver);
    const before = getSessionById(sessionId)!;
    const after = await clearBrowserStateSession(user.id, sessionId);
    expect(runner.calls.some((entry) => entry.command === "clear-state")).toBe(true);
    expect(listSessionEvents(sessionId).some((event) => event.type === "browser_state_cleared")).toBe(true);
    // Session identity, status, and package binding are untouched.
    expect(after.id).toBe(sessionId);
    expect(after.status).toBe(before.status);
    expect(after.package_sha256).toBe(before.package_sha256);
  });

  it("surfaces runner failures without changing session state", async () => {
    const driver = new FakeDriver({ clearStateResult: { ok: false, message: "not supported" } });
    const { user, sessionId } = await startReadySession(driver);
    await expect(clearBrowserStateSession(user.id, sessionId)).rejects.toMatchObject({
      code: "BROWSER_UNAVAILABLE",
    });
    expect(getSessionById(sessionId)!.status).toBe("READY");
  });
});
