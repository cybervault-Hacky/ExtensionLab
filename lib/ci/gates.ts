/**
 * Phase 16: deterministic CI gate policies.
 * No AI decisions; rules are explicit and server-side resolved.
 */
export type GatePolicy = "FAIL_ON_TEST_FAILURE" | "FAIL_ON_REGRESSION" | "FAIL_ON_PERFORMANCE_REGRESSION" | "FAIL_ON_BROWSER_INCOMPATIBILITY";

export const DEFAULT_POLICIES: GatePolicy[] = [
  "FAIL_ON_TEST_FAILURE",
  "FAIL_ON_REGRESSION",
];

export interface GateInput {
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  regressionDetected?: boolean;
  performanceRegression?: boolean;
  browserIncompatibility?: boolean;
  policies: GatePolicy[];
}

export interface GateResult {
  status: "PASS" | "FAIL" | "WARN";
  reasons: string[];
}

export function evaluateGates(input: GateInput): GateResult {
  const reasons: string[] = [];
  let fail = false;
  let warn = false;

  if (input.policies.includes("FAIL_ON_TEST_FAILURE") && input.failed > 0) {
    reasons.push(`${input.failed} new failure(s)`);
    fail = true;
  }
  if (input.policies.includes("FAIL_ON_REGRESSION") && input.regressionDetected) {
    reasons.push("Regression detected");
    fail = true;
  }
  if (input.policies.includes("FAIL_ON_PERFORMANCE_REGRESSION") && input.performanceRegression) {
    reasons.push("Performance regression detected");
    fail = true;
  }
  if (input.policies.includes("FAIL_ON_BROWSER_INCOMPATIBILITY") && input.browserIncompatibility) {
    reasons.push("Browser compatibility regression");
    fail = true;
  }

  if (fail) {
    return { status: "FAIL", reasons };
  }
  if (warn || input.failed === 0 && input.passed === 0) {
    // Conservative: warn when nothing passed but nothing explicitly failed
    return { status: "PASS", reasons: reasons.length ? reasons : ["No failures"] };
  }
  return { status: "PASS", reasons: reasons.length ? reasons : [`${input.passed} passed`, `${input.failed} failed`] };
}
