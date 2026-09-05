import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareBrowserRun } from "@/lib/testing/regression";
import type { RegressionRunEvidence } from "@/lib/testing/regression";
import { setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

function evidence(overrides: Partial<RegressionRunEvidence> = {}): RegressionRunEvidence {
  return {
    browserId: "chromium",
    displayName: "Chromium",
    executed: true,
    score: 98,
    packageVersion: "1.2",
    createdAt: 1,
    results: [],
    consoleEvents: [],
    network: [],
    ...overrides,
  };
}

function testResult(testId: string, status: string, extra: { errors?: string[]; skippedReason?: string } = {}) {
  return {
    testId,
    name: testId,
    description: "",
    category: "page",
    status,
    duration: 1,
    startedAt: 0,
    finishedAt: 1,
    steps: [],
    assertions: [],
    evidence: [],
    errors: extra.errors ?? [],
    warnings: [],
    ...(extra.skippedReason ? { skippedReason: extra.skippedReason } : {}),
  } as never;
}

describe("regression detection rules (Phase 9)", () => {
  it("detects PASS → FAIL as a regression with evidence", () => {
    const report = compareBrowserRun(
      "chromium",
      evidence({ results: [testResult("popup", "passed")] }),
      evidence({ score: 91, packageVersion: "1.3", results: [testResult("popup", "failed", { errors: ["Popup unavailable."] })] }),
    );
    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0]).toMatchObject({ testId: "popup", from: "passed", to: "failed", kind: "test-regression" });
    expect(report.regressions[0].note).toBe("Popup unavailable.");
  });

  it("does not count FAIL → FAIL as a new regression", () => {
    const report = compareBrowserRun(
      "chromium",
      evidence({ score: 60, results: [testResult("popup", "failed", { errors: ["x"] })] }),
      evidence({ score: 60, results: [testResult("popup", "failed", { errors: ["x"] })] }),
    );
    expect(report.regressions).toHaveLength(0);
    expect(report.improvements).toHaveLength(0);
  });

  it("detects PASS → ERROR and PASS → TIMEOUT as regressions", () => {
    for (const to of ["error", "timeout"]) {
      const report = compareBrowserRun(
        "chromium",
        evidence({ results: [testResult("t1", "passed")] }),
        evidence({ results: [testResult("t1", to)] }),
      );
      expect(report.regressions.some((entry) => entry.to === to)).toBe(true);
    }
  });

  it("counts PASS → SKIPPED as a regression only when the skip is meaningful (capability)", () => {
    const capabilitySkip = compareBrowserRun(
      "firefox",
      evidence({ results: [testResult("network", "passed")] }),
      evidence({ results: [testResult("network", "skipped", { skippedReason: "Assertion requires a capability the Firefox runtime does not support." })] }),
    );
    expect(capabilitySkip.regressions).toHaveLength(1);

    const ordinarySkip = compareBrowserRun(
      "firefox",
      evidence({ results: [testResult("network", "passed")] }),
      evidence({ results: [testResult("network", "skipped", { skippedReason: "No content script is configured." })] }),
    );
    expect(ordinarySkip.regressions).toHaveLength(0);
  });

  it("detects FAIL → PASS improvements", () => {
    const report = compareBrowserRun(
      "chromium",
      evidence({ score: 50, results: [testResult("popup", "failed", { errors: ["x"] })] }),
      evidence({ score: 100, results: [testResult("popup", "passed")] }),
    );
    expect(report.improvements).toHaveLength(1);
    expect(report.regressions).toHaveLength(0);
  });

  it("detects new runtime errors, console errors and network failures by signature/url", () => {
    const report = compareBrowserRun(
      "chromium",
      evidence({
        consoleEvents: [{ id: "1", timestamp: 1, type: "error", level: "error", source: "page", message: "Old error at line 5" }],
        network: [{ id: "n1", timestamp: 1, method: "GET", url: "https://x.example/a", status: 500, resourceType: "xhr", duration: 1 }],
      }),
      evidence({
        consoleEvents: [
          { id: "2", timestamp: 2, type: "error", level: "error", source: "page", message: "Old error at line 9" },
          { id: "3", timestamp: 3, type: "error", level: "error", source: "page", message: "New error at line 1" },
        ],
        network: [
          { id: "n2", timestamp: 2, method: "GET", url: "https://x.example/a", status: 500, resourceType: "xhr", duration: 1 },
          { id: "n3", timestamp: 3, method: "GET", url: "https://x.example/b", status: 403, resourceType: "xhr", duration: 1 },
        ],
      }),
    );
    expect(report.newRuntimeErrors).toHaveLength(1);
    expect(report.newConsoleErrors.some((message) => message.includes("New error"))).toBe(true);
    expect(report.newNetworkFailures).toEqual(["GET https://x.example/b → 403"]);
  });

  it("reports a score decrease even without per-test regressions", () => {
    const report = compareBrowserRun(
      "chromium",
      evidence({ score: 98 }),
      evidence({ score: 84 }),
    );
    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0].kind).toBe("score-decrease");
  });

  it("never compares against an unexecuted side", () => {
    const report = compareBrowserRun(
      "chromium",
      evidence({ executed: false }),
      evidence({ results: [testResult("t", "failed", { errors: ["x"] })] }),
    );
    expect(report.regressions).toHaveLength(0);
    expect(report.executed).toEqual({ previous: false, current: true });
  });
});
