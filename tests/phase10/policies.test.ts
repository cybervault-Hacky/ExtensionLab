import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { evaluatePolicy, updateOrganizationPolicy, getOrganizationPolicyRules, evidenceForMatrixRun } from "@/lib/policies/service";
import { createOrganization } from "@/lib/organizations/service";
import { createMatrixRunRow, createMatrixExecutionRow } from "@/lib/db/repositories/browser-matrix";
import { createPackageRecord } from "@/lib/db/repositories/packages";
import { createTestRun } from "@/lib/db/repositories/test-runs";
import type { PolicyEvidence } from "@/lib/policies/service";
import { AppError } from "@/lib/observability/errors";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

const evidence = (overrides: Partial<PolicyEvidence> = {}): PolicyEvidence => ({
  analysis: { healthScore: 90, criticalFindings: 0, highFindings: 1 },
  testRun: { outcome: "PASSED", status: "completed", failedTestIds: [], skippedTestIds: [], executedTestIds: ["t1", "t2"] },
  browserMatrix: {
    status: "completed",
    compatibilityScore: 96,
    executions: [
      { browserId: "chromium", outcome: "PASSED", status: "completed" },
      { browserId: "edge", outcome: "PASSED", status: "completed" },
      { browserId: "firefox", outcome: "PASSED", status: "completed" },
    ],
  },
  regression: { regressionCount: 0 },
  ...overrides,
});

describe("policy evaluation", () => {
  it("PASS when every applicable gate passes", () => {
    const verdict = evaluatePolicy(
      { minHealthScore: 80, maxCriticalFindings: 0, maxHighFindings: 2, requiredTestIds: ["t1", "t2"], requiredBrowsers: ["chromium", "edge", "firefox"], allowRegressions: false },
      evidence(),
    );
    expect(verdict.result).toBe("PASS");
    expect(verdict.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("FAIL when any gate fails, even if others pass", () => {
    const verdict = evaluatePolicy({ minHealthScore: 80, maxCriticalFindings: 0 }, evidence({ analysis: { healthScore: 90, criticalFindings: 3, highFindings: 0 } }));
    expect(verdict.result).toBe("FAIL");
  });

  it("NOT_EVALUATED when no gate could run", () => {
    const verdict = evaluatePolicy({ minHealthScore: 80 }, evidence({ analysis: null }));
    expect(verdict.result).toBe("NOT_EVALUATED");
  });

  it("infrastructure failures never produce PASS", () => {
    const broken = evidence({
      browserMatrix: {
        status: "partial",
        compatibilityScore: null,
        executions: [{ browserId: "chromium", outcome: "INFRASTRUCTURE_ERROR", status: "failed" }],
      },
    });
    const verdict = evaluatePolicy({ requiredBrowsers: ["chromium"] }, broken);
    expect(verdict.result).not.toBe("PASS");
  });

  it("regression gate blocks when regressions are detected and allowRegressions is false", () => {
    const withRegressions = evidence({ regression: { regressionCount: 2 } });
    expect(evaluatePolicy({ allowRegressions: false, minHealthScore: 80 }, withRegressions).result).toBe("FAIL");
    expect(evaluatePolicy({ allowRegressions: true, minHealthScore: 80 }, withRegressions).result).toBe("PASS");
    // No regression gate configured → regressions alone do not fail the policy.
    expect(evaluatePolicy({ minHealthScore: 80 }, withRegressions).result).toBe("PASS");
  });

  it("missing required tests or browsers fail", () => {
    expect(evaluatePolicy({ requiredTestIds: ["t3"] }, evidence()).result).toBe("FAIL");
    expect(evaluatePolicy({ requiredBrowsers: ["edge"] }, evidence({ browserMatrix: { status: "completed", compatibilityScore: 50, executions: [{ browserId: "chromium", outcome: "PASSED", status: "completed" }] } })).result).toBe("FAIL");
  });

  it("rules are clamped to sane bounds, validated and persist per organization", () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Policy Co" });
    const rejected = updateOrganizationPolicy({ userId: owner.id, organizationId: org.id }, { requiredBrowsers: ["safari"] });
    expect(rejected.requiredBrowsers ?? []).toEqual([]);
    const saved = updateOrganizationPolicy({ userId: owner.id, organizationId: org.id }, { minHealthScore: 500, maxCriticalFindings: -4 });
    expect((saved.minHealthScore ?? 0)).toBeLessThanOrEqual(100);
    expect((saved.maxCriticalFindings ?? 0)).toBeGreaterThanOrEqual(0);
    expect(getOrganizationPolicyRules(org.id)).toEqual(saved);
  });

  it("deterministic: identical inputs always produce identical verdicts", () => {
    const rules = { minHealthScore: 85, maxHighFindings: 0 };
    const input = evidence({ analysis: { healthScore: 90, criticalFindings: 0, highFindings: 5 } });
    const first = evaluatePolicy(rules, input);
    for (let index = 0; index < 5; index += 1) expect(evaluatePolicy(rules, input)).toEqual(first);
    expect(first.result).toBe("FAIL");
  });

  it("evidenceForMatrixRun derives policy evidence from stored matrix data", () => {
    const owner = makeUser();
    const pkg = createPackageRecord({ userId: owner.id, extensionId: null, storageKey: "packages/x", sha256: "a".repeat(64), size: 10, version: "1.0.0", originalName: "x.zip" });
    const matrix = createMatrixRunRow({ userId: owner.id, extensionId: null, packageId: pkg.id, testSuiteId: "core", testSuiteName: "Core", browsers: ["chromium", "edge"] });
    const runChromium = createTestRun({ userId: owner.id, extensionId: null, status: "queued" });
    const runEdge = createTestRun({ userId: owner.id, extensionId: null, status: "queued" });
    createMatrixExecutionRow({ matrixRunId: matrix.id, browserId: "chromium", testRunId: runChromium.id, jobId: null });
    createMatrixExecutionRow({ matrixRunId: matrix.id, browserId: "edge", testRunId: runEdge.id, jobId: null });
    const derived = evidenceForMatrixRun(matrix);
    expect(derived.browserMatrix?.executions).toHaveLength(2);
    // No analysis snapshot exists for the package → analysis evidence is null.
    expect(derived.analysis).toBeNull();
  });
});
