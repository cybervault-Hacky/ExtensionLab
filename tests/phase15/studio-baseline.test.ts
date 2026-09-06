import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { isFlakySuspect } from "@/lib/db/repositories/saved-tests";
import { compareSavedTestRuns, REGRESSION_THRESHOLDS, type SavedTestRunSummary } from "@/lib/testing/studio-baseline";
import { createStudioTest, saveRunAsBaseline, compareRunToBaseline, runStudioTest, updateStudioTest, type StudioViewer } from "@/lib/testing/studio-service";
import { makeUser, setupPhase15Harness, storedStudioPackage, validDefinition, type Harness } from "./helpers";

/**
 * Phase 15 §47–§49: baselines and deterministic regression classification.
 * The classifier is a pure function — no AI, no heuristics; flaky detection
 * never fires on a single failure.
 */

let harness: Harness;

beforeEach(() => {
  harness = setupPhase15Harness();
});

afterEach(() => {
  harness.teardown();
});

function summary(overrides: Partial<SavedTestRunSummary>): SavedTestRunSummary {
  return {
    outcome: "PASSED",
    durationMs: 10_000,
    browserId: "chromium",
    packageSha256: "abc",
    testVersion: 1,
    passed: 3,
    failed: 0,
    warnings: 0,
    consoleErrors: 0,
    runtimeErrors: 0,
    networkFailures: 0,
    assertionFingerprints: ["extension_loaded#0:p"],
    ...overrides,
  };
}

describe("deterministic classification (pure function)", () => {
  it("classifies the six outcomes exactly", () => {
    expect(compareSavedTestRuns(summary({}), summary({})).classification).toBe("NO_REGRESSION");
    expect(compareSavedTestRuns(summary({}), summary({ outcome: "FAILED", failed: 1, passed: 2 })).classification).toBe("NEW_FAILURE");
    expect(compareSavedTestRuns(summary({ outcome: "FAILED", failed: 1 }), summary({})).classification).toBe("FIXED_FAILURE");
    expect(compareSavedTestRuns(summary({ outcome: "FAILED", failed: 2 }), summary({ outcome: "FAILED", failed: 1 })).classification).toBe("UNCHANGED_FAILURE");
    expect(compareSavedTestRuns(summary({}), summary({ warnings: 3 })).classification).toBe("NEW_WARNING");
    expect(compareSavedTestRuns(summary({ durationMs: 10_000 }), summary({ durationMs: 10_000 * REGRESSION_THRESHOLDS.relativeSlowdown + 4000 })).classification).toBe("PERFORMANCE_REGRESSION");
  });

  it("requires both an absolute and relative duration slowdown (no hair-trigger)", () => {
    // 60% slower but under the absolute floor → NOT a performance regression.
    expect(compareSavedTestRuns(summary({ durationMs: 1000 }), summary({ durationMs: 1700 })).classification).toBe("NO_REGRESSION");
    // Large absolute but under the relative threshold → NOT a regression.
    expect(compareSavedTestRuns(summary({ durationMs: 9000 }), summary({ durationMs: 11_000 })).classification).toBe("NO_REGRESSION");
  });

  it("marks runs on different browsers as not comparable instead of guessing", () => {
    const comparison = compareSavedTestRuns(summary({}), summary({ browserId: "firefox", outcome: "FAILED", failed: 1 }));
    expect(comparison.comparable).toBe(false);
    expect(comparison.classification).toBe("NO_REGRESSION");
  });

  it("flaky detection needs ≥4 runs and ≥3 pass/fail alternations — one failure never flags", () => {
    expect(isFlakySuspect(["PASSED", "FAILED"])).toBe(false);
    expect(isFlakySuspect(["FAILED", "FAILED", "FAILED", "FAILED"])).toBe(false);
    expect(isFlakySuspect(["PASSED", "FAILED", "PASSED", "FAILED"])).toBe(true);
    expect(isFlakySuspect(["PASSED", "FAILED", "FAILED", "PASSED"])).toBe(false);
    expect(isFlakySuspect(["PASSED", "TIMEOUT", "PASSED", "TIMEOUT"])).toBe(false);
  });
});

describe("baseline service (Save Run as Baseline + compare)", () => {
  async function finishedRun(viewer: StudioViewer, testId: string, outcome: "PASSED" | "FAILED", durationMs: number): Promise<string> {
    const created = await runStudioTest(viewer, testId, { source: "interactive" });
    const runId = created.runId;
    const started = Date.now() - durationMs;
    getDb()
      .prepare("UPDATE test_runs SET status = 'completed', outcome = ?, started_at = ?, completed_at = ?, passed = ?, failed = ?, result_json = ? WHERE id = ?")
      .run(
        outcome,
        started,
        started + durationMs,
        outcome === "PASSED" ? 1 : 0,
        outcome === "PASSED" ? 0 : 1,
        JSON.stringify({
          results: [
            {
              testId: `saved_${testId}_v1`,
              status: outcome === "PASSED" ? "passed" : "failed",
              assertions: [{ assertion: { type: "extension_loaded" }, passed: outcome === "PASSED" }],
              errors: outcome === "PASSED" ? [] : ["assertion failed"],
            },
          ],
        }),
        runId,
      );
    return runId;
  }

  it("saves a finished run as baseline and classifies a later run deterministically", async () => {
    const user = makeUser();
    const { packageId } = await storedStudioPackage(user);
    const viewer: StudioViewer = { userId: user.id, organizationId: null };
    const test = await createStudioTest(viewer, { name: "Base", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
    await updateStudioTest(viewer, test.id, { status: "ACTIVE" });

    const baselineRun = await finishedRun(viewer, test.id, "PASSED", 5000);
    const baseline = saveRunAsBaseline(viewer, test.id, baselineRun);
    expect(baseline.outcome).toBe("PASSED");
    expect(baseline.test_version).toBe(1);

    const failingRun = await finishedRun(viewer, test.id, "FAILED", 5200);
    const comparison = compareRunToBaseline(viewer, test.id, failingRun);
    expect(comparison.comparison.classification).toBe("NEW_FAILURE");
    expect(comparison.comparison.findings.join(" ")).toMatch(/passed at baseline but fails now/i);

    const recoveredRun = await finishedRun(viewer, test.id, "PASSED", 4800);
    const recovered = compareRunToBaseline(viewer, test.id, recoveredRun);
    expect(recovered.comparison.classification).toBe("NO_REGRESSION");
  });

  it("refuses baselines from other tests, other users, and unfinished runs", async () => {
    const user = makeUser();
    const { packageId } = await storedStudioPackage(user);
    const viewer: StudioViewer = { userId: user.id, organizationId: null };
    const test = await createStudioTest(viewer, { name: "A", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
    const other = await createStudioTest(viewer, { name: "B", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
    await updateStudioTest(viewer, test.id, { status: "ACTIVE" });

    const runOfA = await finishedRun(viewer, test.id, "PASSED", 4000);
    expect(() => saveRunAsBaseline(viewer, other.id, runOfA)).toThrow(/did not execute this saved test/);

    expect(() => saveRunAsBaseline({ userId: "usr_stranger", organizationId: null }, test.id, runOfA)).toThrow(/not found/i);

    const created = await runStudioTest(viewer, test.id, { source: "interactive" });
    expect(() => saveRunAsBaseline(viewer, test.id, created.runId)).toThrow(/finished/);
  });
});
