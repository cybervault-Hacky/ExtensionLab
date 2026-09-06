import "server-only";
import { getDb } from "@/lib/db/client";
import { generateDbId } from "@/lib/db/ids";
import type { SavedTestBaselineRow, TestRunRow } from "@/lib/db/schema/types";
import { parseResults } from "./run-service";

/**
 * Phase 15 saved-test baselines ("Save Run as Baseline", §47–§48).
 *
 * Classification is a pure, deterministic function of two run summaries —
 * never AI-decided, never inferred from names or content. Screenshot diffing
 * is intentionally NOT implemented: the artifact store keeps screenshots but
 * has no pixel-comparison service, and Phase 15 forbids claiming pixel-perfect
 * or thresholded image diffs that do not exist. Duration regression uses
 * explicit thresholds and is only reported on an explicit compare.
 */

export interface SavedTestRunSummary {
  outcome: string;
  durationMs: number | null;
  browserId: string;
  packageSha256: string;
  testVersion: number | null;
  passed: number;
  failed: number;
  warnings: number;
  consoleErrors: number;
  runtimeErrors: number;
  networkFailures: number;
  /** Assertion fingerprints in execution order: `${type}#${index}:${passed}`. */
  assertionFingerprints: string[];
}

export function buildSavedTestRunSummary(run: TestRunRow): SavedTestRunSummary {
  const parsed = parseResults(run);
  const consoleErrors = parsed.results.reduce(
    (count, result) => count + result.assertions.filter((entry) => entry.assertion.type.startsWith("console") && entry.passed === false && entry.skipped !== true).length,
    0,
  );
  const runtimeErrors = parsed.results.reduce(
    (count, result) => count + result.errors.filter((message) => /runtime|internal runner|uncaught/i.test(message)).length,
    0,
  );
  const networkFailures = parsed.results.reduce(
    (count, result) => count + result.assertions.filter((entry) => entry.assertion.type.startsWith("network") && entry.passed === false && entry.skipped !== true).length,
    0,
  );
  const durationMs = typeof run.started_at === "number" && typeof run.completed_at === "number" ? run.completed_at - run.started_at : null;
  return {
    outcome: run.outcome ?? "UNKNOWN",
    durationMs,
    browserId: run.browser_id ?? "chromium",
    packageSha256: run.package_id ?? "",
    testVersion: run.saved_test_version ?? null,
    passed: run.passed,
    failed: run.failed,
    warnings: run.warnings,
    consoleErrors,
    runtimeErrors,
    networkFailures,
    assertionFingerprints: parsed.results.flatMap((result) =>
      result.assertions.map((entry, index) => `${entry.assertion.type}#${index}:${entry.passed ? "p" : "f"}`),
    ),
  };
}

export type SavedTestRegressionClassification =
  | "NEW_FAILURE"
  | "FIXED_FAILURE"
  | "UNCHANGED_FAILURE"
  | "NEW_WARNING"
  | "PERFORMANCE_REGRESSION"
  | "NO_REGRESSION";

export interface SavedTestComparison {
  classification: SavedTestRegressionClassification;
  findings: string[];
  comparable: boolean;
}

/** Deterministic thresholds; no ML, no single-run background alerting. */
export const REGRESSION_THRESHOLDS = {
  /** Duration regression requires ≥50% slower AND ≥3 s absolute slowdown. */
  relativeSlowdown: 1.5,
  absoluteSlowdownMs: 3000,
} as const;

export function compareSavedTestRuns(baseline: SavedTestRunSummary, current: SavedTestRunSummary): SavedTestComparison {
  const findings: string[] = [];
  const comparable = baseline.outcome !== "UNKNOWN" && current.outcome !== "UNKNOWN" && baseline.browserId === current.browserId;
  const baselineFailed = baseline.outcome === "FAILED" || baseline.failed > 0;
  const currentFailed = current.outcome === "FAILED" || current.failed > 0;

  if (!comparable) {
    return {
      classification: "NO_REGRESSION",
      findings: ["The runs are not directly comparable (different browsers or an unfinished run); no regression was classified."],
      comparable: false,
    };
  }
  if (!baselineFailed && currentFailed) findings.push("The test passed at baseline but fails now.");
  if (baselineFailed && !currentFailed) findings.push("The test failed at baseline but passes now.");
  if (baselineFailed && currentFailed) findings.push("The test failed at baseline and still fails.");
  if (current.consoleErrors > baseline.consoleErrors) findings.push(`Console errors increased (${baseline.consoleErrors} → ${current.consoleErrors}).`);
  if (current.runtimeErrors > baseline.runtimeErrors) findings.push(`Runtime errors increased (${baseline.runtimeErrors} → ${current.runtimeErrors}).`);
  if (current.networkFailures > baseline.networkFailures) findings.push(`Network failures increased (${baseline.networkFailures} → ${current.networkFailures}).`);
  if (current.warnings > baseline.warnings && !currentFailed) findings.push(`Warnings increased (${baseline.warnings} → ${current.warnings}).`);
  const durationRegression =
    baseline.durationMs !== null &&
    current.durationMs !== null &&
    current.durationMs > baseline.durationMs * REGRESSION_THRESHOLDS.relativeSlowdown &&
    current.durationMs - baseline.durationMs > REGRESSION_THRESHOLDS.absoluteSlowdownMs;
  if (durationRegression) findings.push(`Duration regressed (${baseline.durationMs} ms → ${current.durationMs} ms; threshold ≥50% and ≥${REGRESSION_THRESHOLDS.absoluteSlowdownMs} ms).`);

  const classification: SavedTestRegressionClassification = !baselineFailed && currentFailed
    ? "NEW_FAILURE"
    : baselineFailed && currentFailed
      ? "UNCHANGED_FAILURE"
      : baselineFailed && !currentFailed
        ? "FIXED_FAILURE"
        : durationRegression
          ? "PERFORMANCE_REGRESSION"
          : findings.length > 0
            ? "NEW_WARNING"
            : "NO_REGRESSION";
  return { classification, findings, comparable: true };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function setSavedTestBaseline(input: {
  userId: string;
  savedTestId: string;
  runId: string;
  testVersion: number;
  packageSha256: string;
  browserId: string;
  outcome: string;
  durationMs: number | null;
  summary: SavedTestRunSummary;
}): SavedTestBaselineRow {
  const db = getDb();
  const now = Date.now();
  const existing = getSavedTestBaseline(input.userId, input.savedTestId);
  db.prepare(
    `INSERT INTO saved_test_baselines
       (id, user_id, saved_test_id, run_id, test_version, package_sha256, browser_id, outcome, duration_ms, summary_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, saved_test_id) DO UPDATE SET
       run_id = excluded.run_id,
       test_version = excluded.test_version,
       package_sha256 = excluded.package_sha256,
       browser_id = excluded.browser_id,
       outcome = excluded.outcome,
       duration_ms = excluded.duration_ms,
       summary_json = excluded.summary_json,
       created_at = excluded.created_at`,
  ).run(
    existing?.id ?? generateDbId("stbase"),
    input.userId,
    input.savedTestId,
    input.runId,
    input.testVersion,
    input.packageSha256,
    input.browserId,
    input.outcome,
    input.durationMs,
    JSON.stringify(input.summary),
    now,
  );
  return getSavedTestBaseline(input.userId, input.savedTestId)!;
}

export function getSavedTestBaseline(userId: string, savedTestId: string): SavedTestBaselineRow | null {
  return (
    (getDb().prepare("SELECT * FROM saved_test_baselines WHERE user_id = ? AND saved_test_id = ?").get(userId, savedTestId) as
      | SavedTestBaselineRow
      | undefined) ?? null
  );
}
