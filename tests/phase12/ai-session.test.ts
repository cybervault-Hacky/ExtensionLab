import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { explainSessionError, summarizeSession } from "@/lib/interactive/ai";
import { getConsoleEntries, getNetworkEntries } from "@/lib/interactive/service";
import { makeUser } from "../phase11/helpers";
import { subscribe } from "../phase8/helpers";
import { FakeDriver, setupPhase12Harness, startReadySession, waitFor, type Harness } from "./helpers";

let harness: ReturnType<typeof setupPhase12Harness>;

beforeEach(() => {
  harness = setupPhase12Harness();
});

afterEach(() => {
  harness.teardown();
});

/**
 * AI is an explanation layer over the session's real runtime records. These
 * tests exercise the REAL AI pipeline (redaction, bounding, entitlement)
 * against the deterministic fake provider.
 */
/** Free plan has no AI quota; AI features require a paid plan (server-side). */
function subscribeAndMakePro() {
  const user = makeUser();
  subscribe(user.id, "pro");
  return user;
}

describe("Phase 12 §57: session AI features (explanation layer only)", () => {
  it("explains a runtime error with the real pipeline and redacts secrets", async () => {
    const driver = new FakeDriver();
    const { user, sessionId, runner } = await startReadySession(driver, subscribeAndMakePro());
    getConsoleEntries(user.id, sessionId); // attaches the hub stream…
    await waitFor(() => (runner.eventListeners.size > 0 ? true : null), 3000, "hub stream attach");
    runner.emitConsole("Uncaught TypeError: GET /login?password=hunter2-not-real threw at bg.js:1", "error");
    await waitFor(
      () => getConsoleEntries(user.id, sessionId).entries.find((entry) => entry.message.includes("TypeError")) ?? null,
      5000,
      "console entry",
    );

    const envelope = await explainSessionError("req-test", user.id, sessionId, null);
    expect(envelope.feature).toBe("analyze_runtime_error");
    expect(envelope.result.kind).toBe("explanation");
    expect(envelope.meta.disclaimer).toBeTruthy();

    // The provider prompt is built from bounded projections and must not
    // contain the planted secret.
    const prompt = harness.ai.fake.prompts().at(-1)?.user ?? "";
    expect(prompt).not.toContain("hunter2-not-real");
    expect(prompt).toContain("REDACTED");
  });

  it("summarizes the session with verified evidence projections", async () => {
    const driver = new FakeDriver();
    const { user, sessionId, runner } = await startReadySession(driver, subscribeAndMakePro());
    getConsoleEntries(user.id, sessionId); // attaches the hub stream…
    await waitFor(() => (runner.eventListeners.size > 0 ? true : null), 3000, "hub stream attach");
    getNetworkEntries(user.id, sessionId);
    runner.emitConsole("page ready", "log");
    runner.emitNetwork("https://example.com/api", 200);
    await waitFor(
      () => getNetworkEntries(user.id, sessionId).entries.find((entry) => entry.url.includes("example.com")) ?? null,
      5000,
      "network entry",
    );

    const envelope = await summarizeSession("req-test", user.id, sessionId);
    expect(envelope.feature).toBe("summarize_report");
    expect(envelope.result.kind).toBe("summary");
    const prompt = harness.ai.fake.prompts().at(-1)?.user ?? "";
    expect(prompt).toContain("browser_session");
  });

  it("fails honestly when AI is not configured", async () => {
    // Plain Phase 11 harness: no pinned provider, AI disabled in configuration.
    const { setupHarness: setupPlainHarness } = await import("../phase11/helpers");
    const { setAIProviderForTests } = await import("@/lib/ai/provider");
    const harnessOff = setupPlainHarness({ AI_PROVIDER: "disabled" });
    setAIProviderForTests(null); // no pinned provider: configuration decides
    try {
      const driver = new FakeDriver();
      const { user, sessionId } = await startReadySession(driver, subscribeAndMakePro());
      await expect(explainSessionError("req-test", user.id, sessionId, null)).rejects.toThrowError(/AI/);
      await expect(summarizeSession("req-test", user.id, sessionId)).rejects.toThrowError(/AI/);
    } finally {
      setAIProviderForTests(harness.ai);
      harnessOff.teardown();
    }
  });
});
