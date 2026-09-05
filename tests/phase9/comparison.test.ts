import { describe, expect, it } from "vitest";
import { buildMatrixComparison, normalizeErrorSignature } from "@/lib/testing/comparison";
import type { BrowserExecutionEvidence } from "@/lib/testing/comparison";

/**
 * Deterministic cross-browser comparison. All inputs are recorded evidence —
 * the comparison never fabricates results.
 */

function execution(overrides: Partial<BrowserExecutionEvidence> & { browserId: string }): BrowserExecutionEvidence {
  return {
    displayName: overrides.browserId,
    browserVersion: "100.0",
    engine: "chromium",
    executed: true,
    outcome: "PASSED",
    score: 100,
    durationMs: 5000,
    results: [],
    consoleEvents: [],
    network: [],
    screenshotCount: 0,
    ...overrides,
  };
}

function result(testId: string, status: string, extra: Partial<{ errors: string[]; skippedReason: string }> = {}) {
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

describe("buildMatrixComparison (Phase 9)", () => {
  it("scores 100 when all requested browsers pass and states its deterministic basis", () => {
    const comparison = buildMatrixComparison({
      requestedBrowsers: ["chromium", "edge", "firefox"],
      executions: [
        execution({ browserId: "chromium", outcome: "PASSED" }),
        execution({ browserId: "edge", outcome: "PASSED" }),
        execution({ browserId: "firefox", outcome: "WARNING", score: 80 }),
      ],
      engineByBrowser: {},
    });
    expect(comparison.compatibility.score).toBe(100);
    expect(comparison.compatibility.coverage).toBe(1);
    expect(comparison.compatibility.browsersPassing).toEqual(["chromium", "edge", "firefox"]);
    expect(comparison.compatibility.basis).toMatch(/deterministic/i);
  });

  it("produces PARTIAL semantics: chromium+edge pass, firefox fails → browser-only failure finding", () => {
    const comparison = buildMatrixComparison({
      requestedBrowsers: ["chromium", "edge", "firefox"],
      executions: [
        execution({
          browserId: "chromium",
          results: [result("popup", "passed")],
        }),
        execution({
          browserId: "edge",
          results: [result("popup", "passed")],
        }),
        execution({
          browserId: "firefox",
          outcome: "FAILED",
          score: 50,
          results: [result("popup", "failed", { errors: ["Popup is not available in this environment."] })],
        }),
      ],
      engineByBrowser: {},
    });
    expect(comparison.compatibility.score).toBe(67); // 2/3 executed browsers passing
    expect(comparison.compatibility.browsersFailing).toEqual(["firefox"]);
    const finding = comparison.findings.find((entry) => entry.type === "BROWSER_ONLY_FAILURE");
    expect(finding).toBeDefined();
    expect(finding?.title).toMatch(/Cross-browser compatibility issue detected/i);
    expect(finding?.description).not.toMatch(/firefox bug/i);
    const popupRow = comparison.tests.find((row) => row.testId === "popup");
    expect(popupRow?.differs).toBe(true);
    expect(popupRow?.cells.chromium.status).toBe("passed");
    expect(popupRow?.cells.firefox.status).toBe("failed");
  });

  it("does not let infrastructure failures reduce the compatibility score — it reports insufficient data", () => {
    const comparison = buildMatrixComparison({
      requestedBrowsers: ["chromium", "firefox"],
      executions: [
        execution({ browserId: "chromium", outcome: "PASSED" }),
        execution({ browserId: "firefox", executed: false, outcome: "INFRASTRUCTURE_ERROR", errorCode: "BROWSER_RUNTIME_UNAVAILABLE", reason: "image missing" }),
      ],
      engineByBrowser: {},
    });
    expect(comparison.compatibility.score).toBe(100); // 1/1 executed
    expect(comparison.compatibility.browsersUnavailable).toEqual(["firefox"]);
    expect(comparison.compatibility.coverage).toBe(0.5);
    const finding = comparison.findings.find((entry) => entry.type === "INFRASTRUCTURE_UNAVAILABLE");
    expect(finding?.description).toMatch(/not counted as an extension failure/i);
  });

  it("returns null score with zero coverage when nothing executed", () => {
    const comparison = buildMatrixComparison({
      requestedBrowsers: ["chromium"],
      executions: [execution({ browserId: "chromium", executed: false, outcome: "INFRASTRUCTURE_ERROR" })],
      engineByBrowser: {},
    });
    expect(comparison.compatibility.score).toBeNull();
    expect(comparison.compatibility.coverage).toBe(0);
    expect(comparison.compatibility.basis).toMatch(/insufficient execution data/i);
  });

  it("flags unsupported tests as skipped findings, not failures", () => {
    const comparison = buildMatrixComparison({
      requestedBrowsers: ["chromium", "firefox"],
      executions: [
        execution({ browserId: "chromium", results: [result("network-check", "passed")] }),
        execution({
          browserId: "firefox",
          results: [result("network-check", "skipped", { skippedReason: "Assertion network_status_equals requires a capability the Firefox runtime does not support (networkStatusCodes)." })],
        }),
      ],
      engineByBrowser: {},
    });
    expect(comparison.compatibility.unsupportedTests).toBe(1);
    const finding = comparison.findings.find((entry) => entry.type === "UNSUPPORTED_FEATURE");
    expect(finding).toBeDefined();
    expect(comparison.compatibility.browsersFailing).toHaveLength(0);
  });

  it("detects network status differences only from recorded evidence", () => {
    const comparison = buildMatrixComparison({
      requestedBrowsers: ["chromium", "edge"],
      executions: [
        execution({
          browserId: "chromium",
          network: [
            { id: "n1", timestamp: 1, method: "GET", url: "https://api.example.com/v1/data", status: 200, resourceType: "xhr", duration: 12 },
          ],
        }),
        execution({
          browserId: "edge",
          network: [
            { id: "n2", timestamp: 1, method: "GET", url: "https://api.example.com/v1/data", status: 403, resourceType: "xhr", duration: 20 },
          ],
        }),
      ],
      engineByBrowser: {},
    });
    const finding = comparison.findings.find((entry) => entry.type === "NETWORK_STATUS_DIFFERENCE");
    expect(finding).toBeDefined();
    expect(finding?.description).toMatch(/200/);
    expect(finding?.description).toMatch(/403/);
    expect(comparison.network[0].statuses).toEqual({ chromium: 200, edge: 403 });
  });

  it("groups runtime errors by normalized signature into common vs browser-specific", () => {
    const comparison = buildMatrixComparison({
      requestedBrowsers: ["chromium", "firefox"],
      executions: [
        execution({
          browserId: "chromium",
          consoleEvents: [{ id: "e1", timestamp: 1, type: "error", level: "error", source: "page", message: "TypeError: x is undefined at line 12" }],
        }),
        execution({
          browserId: "firefox",
          consoleEvents: [
            { id: "e2", timestamp: 1, type: "error", level: "error", source: "page", message: "TypeError: x is undefined at line 99" },
            { id: "e3", timestamp: 2, type: "console", level: "error", source: "page", message: "browser.something is not a function" },
          ],
        }),
      ],
      engineByBrowser: {},
    });
    const common = comparison.consoleErrors.find((group) => group.scope === "common");
    expect(common).toBeDefined();
    expect(common?.browsers).toEqual(["chromium", "firefox"]);
    const specific = comparison.findings.find((entry) => entry.type === "RUNTIME_ERROR_BROWSER_SPECIFIC");
    expect(specific).toBeDefined();
    expect(specific?.description).toMatch(/candidate/i);
    expect(specific?.description).not.toMatch(/because/i);
  });

  it("normalizes error signatures deterministically", () => {
    expect(normalizeErrorSignature("TypeError at line 42")).toBe(normalizeErrorSignature("TypeError at line 99"));
    expect(normalizeErrorSignature("Error abc123def456 happened")).not.toBe(normalizeErrorSignature("Error other happened"));
    expect(normalizeErrorSignature("X")).toBe(normalizeErrorSignature("X"));
  });

  it("explains the background model difference for MV3 service workers on Firefox", () => {
    const comparison = buildMatrixComparison({
      requestedBrowsers: ["chromium", "firefox"],
      manifestVersion: "v3",
      executions: [
        execution({ browserId: "chromium", results: [result("service-worker", "passed")] }),
        execution({
          browserId: "firefox",
          results: [result("service-worker", "skipped", { skippedReason: "Unsupported on Firefox: Firefox runs MV3 background execution as an event page..." })],
        }),
      ],
      engineByBrowser: {},
    });
    const finding = comparison.findings.find((entry) => entry.type === "BACKGROUND_MODEL_DIFFERENCE");
    expect(finding).toBeDefined();
    expect(finding?.description).toMatch(/event page/i);
  });
});
