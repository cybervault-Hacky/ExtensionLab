import type { TestResult, TestScore, TestScoreCategory } from "./types";
import { summarizeResults } from "./results";

/**
 * Deterministic scoring.
 *
 * Passed = 100, warning = 50, failed/timeout/error = 0, skipped = excluded.
 * Category scores are only calculated over applicable tests in that category.
 */
const CATEGORY_LABELS: Record<string, string> = {
  loading: "Loading",
  page: "Runtime",
  content_script: "Content Scripts",
  background: "Background",
  console: "Console",
  network: "Network",
  stability: "Stability",
  security: "Security",
  permissions: "Security",
  popup: "Runtime",
  service_worker: "Background",
  manifest: "Security",
  storage: "Runtime",
  performance: "Stability",
};

const STATUS_POINTS: Record<string, number> = {
  passed: 100,
  warning: 50,
  failed: 0,
  timeout: 0,
  error: 0,
  skipped: 0,
  pending: 0,
  running: 0,
};

function categoryKeyFromTest(result: TestResult): string {
  if (result.category === "permissions" || result.category === "manifest") {
    return "security";
  }
  if (result.category === "service_worker" || result.category === "background") {
    return "background";
  }
  if (result.category === "popup" || result.category === "page" || result.category === "storage" || result.category === "loading") {
    return "runtime";
  }
  if (result.category === "performance") {
    return "stability";
  }
  return result.category;
}

export function computeTestScore(results: TestResult[]): TestScore {
  const summary = summarizeResults(results);
  const applicable = results.filter((result) => result.status !== "skipped" && result.status !== "pending" && result.status !== "running");
  if (applicable.length === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      warning: 0,
      skipped: summary.skipped,
      timeout: 0,
      error: 0,
      categories: [],
      basis:
        "Score is based exclusively on automated tests that actually ran. Skipped tests are excluded.",
    };
  }

  const grouped = new Map<string, TestResult[]>();
  for (const result of applicable) {
    const key = categoryKeyFromTest(result);
    const list = grouped.get(key) ?? [];
    list.push(result);
    grouped.set(key, list);
  }

  const categories: TestScoreCategory[] = [];
  let totalPoints = 0;
  let totalWeight = 0;
  for (const [key, list] of grouped.entries()) {
    const sum = list.reduce((acc, result) => acc + (STATUS_POINTS[result.status] ?? 0), 0);
    const score = Math.round(sum / list.length);
    categories.push({
      key,
      label: CATEGORY_LABELS[key] ?? key,
      score,
      applicable: true,
    });
    totalPoints += score;
    totalWeight += 1;
  }

  return {
    total: Math.round(totalPoints / Math.max(1, totalWeight)),
    passed: summary.passed,
    failed: summary.failed,
    warning: summary.warning,
    skipped: summary.skipped,
    timeout: summary.timeout,
    error: summary.error,
    categories: categories.sort((a, b) => b.score - a.score),
    basis:
      "Passed = 100, warning = 50, failed/timeout/error = 0, skipped = excluded. Score is deterministic.",
  };
}
