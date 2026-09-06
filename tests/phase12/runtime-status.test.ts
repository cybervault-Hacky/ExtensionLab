import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { openPopup, stopInteractiveSession, toSessionView } from "@/lib/interactive/service";
import { appendSessionEvent, getSessionById, listSessionEvents } from "@/lib/db/repositories/browser-sessions";
import { FakeDriver, setupPhase12Harness, startReadySession, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase12Harness();
});

afterEach(() => {
  harness.teardown();
});

/**
 * The extension runtime badge must be derived from RECORDED evidence only
 * (durable session events written by the same repository the live hub uses).
 * These tests pin the honesty contract: no status is ever invented.
 */
describe("Phase 12 §57: evidence-derived extension runtime status", () => {
  it("reports READY after a recorded load, RUNNING after real extension activity", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    let row = getSessionById(sessionId)!;
    expect(listSessionEvents(sessionId).some((event) => event.type === "extension_loaded")).toBe(true);
    expect(toSessionView(row).extensionRuntimeStatus).toBe("READY");

    await openPopup(user.id, sessionId); // real popup_opened event = activity
    row = getSessionById(sessionId)!;
    expect(toSessionView(row).extensionRuntimeStatus).toBe("RUNNING");
  });

  it("resets to a fresh load state after a confirmed reload (never stale RUNNING)", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const { reloadExtension } = await import("@/lib/interactive/service");
    await reloadExtension(user.id, sessionId);
    const row = getSessionById(sessionId)!;
    const events = listSessionEvents(sessionId);
    const indexOf = (types: string[]) =>
      Math.max(...events.map((event, index) => (types.includes(event.type) ? index : -1)));
    // A confirmed reload (extension_reloaded) must be newer than its request.
    expect(indexOf(["extension_loaded", "extension_reloaded"])).toBeGreaterThan(indexOf(["extension_reload_requested"]));
    expect(["READY", "RUNNING"]).toContain(toSessionView(row).extensionRuntimeStatus);
  });

  it("maps recorded runtime errors to ERROR with an honest failure kind", async () => {
    const driver = new FakeDriver();
    const { sessionId } = await startReadySession(driver);
    appendSessionEvent(sessionId, {
      type: "runtime_error",
      level: "error",
      message: "Extension service worker threw TypeError",
    });
    const view = toSessionView(getSessionById(sessionId)!);
    expect(view.extensionRuntimeStatus).toBe("ERROR");
    expect(view.failureKind).toBe("extension_runtime_error");

    appendSessionEvent(sessionId, {
      type: "runtime_error",
      level: "error",
      message: "The website https://example.com crashed while loading",
    });
    expect(toSessionView(getSessionById(sessionId)!).failureKind).toBe("page_error");
  });

  it("a reload newer than the error restores a non-error status", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    appendSessionEvent(sessionId, {
      type: "runtime_error",
      level: "error",
      message: "Extension service worker threw TypeError",
    });
    expect(toSessionView(getSessionById(sessionId)!).extensionRuntimeStatus).toBe("ERROR");
    const { reloadExtension } = await import("@/lib/interactive/service");
    await reloadExtension(user.id, sessionId);
    expect(toSessionView(getSessionById(sessionId)!).extensionRuntimeStatus).not.toBe("ERROR");
  });

  it("classifies crashed sessions as browser_crash and stopped sessions as STOPPED", async () => {
    const driver = new FakeDriver();
    const { sessionId } = await startReadySession(driver);
    // The container vanishes mid-session; the deterministic sweep reaps it.
    const { parseRuntimeInfo } = await import("@/lib/interactive/service");
    const runtime = parseRuntimeInfo(getSessionById(sessionId)!)!;
    driver.markCrashed(runtime.containerId);
    const { runInteractiveSweep } = await import("@/lib/interactive/sweep");
    const report = await runInteractiveSweep(driver);
    expect(report.failedOrphans).toBeGreaterThanOrEqual(1);
    const view = toSessionView(getSessionById(sessionId)!);
    expect(view.extensionRuntimeStatus).toBe("ERROR");
    expect(view.failureKind).toBe("browser_crash");

    const ready = await startReadySession(new FakeDriver());
    await stopInteractiveSession(ready.user.id, ready.sessionId, driver);
    expect(toSessionView(getSessionById(ready.sessionId)!).extensionRuntimeStatus).toBe("STOPPED");
  });
});
