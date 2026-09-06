import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createSessionTestRecipe, navigateSession, runTestFromSession } from "@/lib/interactive/service";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { getJobById } from "@/lib/db/repositories/jobs";
import { FakeDriver, setupPhase12Harness, startReadySession, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase12Harness();
});

afterEach(() => {
  harness.teardown();
});

const VALID_ACTIONS = [
  { kind: "navigate", url: "https://example.com/login" },
  { kind: "click", selector: "#login" },
  { kind: "type", selector: "#password", text: "hunter2-not-real" },
  { kind: "wait", milliseconds: 250 },
  { kind: "assert_element", selector: ".dashboard" },
  { kind: "screenshot" },
] as const;

describe("Phase 12 §57: test recipes from session actions (Phase 4 schema)", () => {
  it("converts confirmed actions into validated Phase 4 steps and stores bounded evidence", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const recipe = await createSessionTestRecipe(user.id, sessionId, {
      name: "Login flow",
      actions: [...VALID_ACTIONS],
      confirm: true,
    });
    expect(recipe.name).toBe("Login flow");
    expect(recipe.steps).toEqual([
      { type: "open_url", url: "https://example.com/login" },
      { type: "click", selector: "#login" },
      { type: "type", selector: "#password", value: "hunter2-not-real" },
      { type: "wait", milliseconds: 250 },
      { type: "capture_screenshot" },
    ]);
    expect(recipe.assertions).toEqual([{ type: "element_exists", selector: ".dashboard" }]);
    // Stored as evidence referencing the session — no second test table.
    const { listSessionEvidenceViews } = await import("@/lib/interactive/service");
    const stored = listSessionEvidenceViews(user.id, sessionId).find((item) => item.kind === "test_recipe");
    expect(stored?.label).toBe("Login flow");
    expect(stored?.metadata.recipeId).toBe(recipe.id);
  });

  it("requires explicit confirmation and a name", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    await expect(
      createSessionTestRecipe(user.id, sessionId, { name: "x", actions: [...VALID_ACTIONS], confirm: false }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createSessionTestRecipe(user.id, sessionId, { name: "   ", actions: [...VALID_ACTIONS], confirm: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects unsafe URLs and disallowed selectors atomically", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    await expect(
      createSessionTestRecipe(user.id, sessionId, {
        name: "bad url",
        actions: [{ kind: "navigate", url: "http://127.0.0.1:8080/" }],
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
    await expect(
      createSessionTestRecipe(user.id, sessionId, {
        name: "bad selector",
        actions: [{ kind: "click", selector: "script:has(script)" }],
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // Nothing was persisted by the rejected attempts.
    const { listSessionEvidenceViews } = await import("@/lib/interactive/service");
    expect(listSessionEvidenceViews(user.id, sessionId).filter((item) => item.kind === "test_recipe")).toHaveLength(0);
  });

  it("caps recipe length at 24 steps", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const many = Array.from({ length: 25 }, () => ({ kind: "wait" as const, milliseconds: 10 }));
    await expect(
      createSessionTestRecipe(user.id, sessionId, { name: "long", actions: many, confirm: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("Phase 12 §57: run the standard automated suite from a session", () => {
  it("queues a Phase 4 run against the exact bound package", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const { runId } = await runTestFromSession(user.id, sessionId);
    const { getTestRunById } = await import("@/lib/db/repositories/test-runs");
    const run = getTestRunById(runId);
    expect(run).toBeTruthy();
    expect(run!.package_id).toBe(getSessionById(sessionId)!.package_id);
  });

  it("only forwards an https:// current URL as the test URL", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    // Navigate the fake browser to a page; http:// is refused by policy.
    await expect(navigateSession(user.id, sessionId, { op: "navigate", url: "http://example.com/" })).rejects
      .toMatchObject({ code: "UNSAFE_URL" });
    await navigateSession(user.id, sessionId, { op: "navigate", url: "https://example.com/" });
    const { runId } = await runTestFromSession(user.id, sessionId);
    const { getTestRunById } = await import("@/lib/db/repositories/test-runs");
    const run = getTestRunById(runId)!;
    const job = getJobById(run.job_id!)!;
    const payload = JSON.parse(job.payload_json) as { testUrl?: string };
    expect(payload.testUrl).toBe("https://example.com/");
  });
});
