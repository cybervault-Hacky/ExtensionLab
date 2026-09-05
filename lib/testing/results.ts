import type { TestResult } from "./types";

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  warning: number;
  skipped: number;
  timeout: number;
  error: number;
  pending: number;
  running: number;
}

export function summarizeResults(results: TestResult[]): TestSummary {
  const summary: TestSummary = {
    total: results.length,
    passed: 0,
    failed: 0,
    warning: 0,
    skipped: 0,
    timeout: 0,
    error: 0,
    pending: 0,
    running: 0,
  };
  for (const result of results) {
    switch (result.status) {
      case "passed":
        summary.passed += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "warning":
        summary.warning += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      case "timeout":
        summary.timeout += 1;
        break;
      case "error":
        summary.error += 1;
        break;
      case "pending":
        summary.pending += 1;
        break;
      case "running":
        summary.running += 1;
        break;
    }
  }
  return summary;
}

export function sortResults(results: TestResult[]): TestResult[] {
  return results.slice().sort((a, b) => a.testId.localeCompare(b.testId));
}

export function resultSortKey(result: TestResult): string {
  return result.testId;
}
