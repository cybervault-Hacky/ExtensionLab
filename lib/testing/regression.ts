import "server-only";
import { normalizeErrorSignature } from "./comparison";
import type { NetworkEntryLike, RuntimeEventLike, TestResult } from "./types";
import type { RunOutcome } from "@/lib/db/repositories/test-runs";

/**
 * Phase 9 regression detection.
 *
 * Compares two executions of the same test suite (previous package version vs
 * current) per browser. Detection is deterministic and evidence-based:
 *
 *   regression:     PASS → FAIL / ERROR / TIMEOUT
 *                   PASS → SKIPPED (capability became unavailable — meaningful)
 *                   new runtime errors / console errors / network failures
 *                   lower score
 *   improvement:    FAIL / ERROR / TIMEOUT → PASS
 *   never counted:  FAIL → FAIL (an existing failure is not a new regression)
 *
 * Root causes are never claimed; only observed transitions are reported.
 */

export type RegressionKind = "test-regression" | "score-decrease" | "new-runtime-error" | "new-console-error" | "new-network-failure";
export type ImprovementKind = "test-improvement" | "score-increase";

export interface RegressionEntry {
  testId: string;
  testName: string;
  from: string;
  to: string;
  kind: RegressionKind;
  note?: string;
}

export interface ImprovementEntry {
  testId: string;
  testName: string;
  from: string;
  to: string;
  kind: ImprovementKind;
}

export interface BrowserRegressionReport {
  browserId: string;
  displayName: string;
  executed: { previous: boolean; current: boolean };
  previousScore: number | null;
  currentScore: number | null;
  regressions: RegressionEntry[];
  improvements: ImprovementEntry[];
  newRuntimeErrors: string[];
  newConsoleErrors: string[];
  newNetworkFailures: string[];
}

export interface RegressionComparisonResult {
  schemaVersion: 1;
  previous: { label: string; matrixRunId: string | null; runId: string | null; packageVersion: string | null; createdAt: number };
  current: { label: string; matrixRunId: string | null; runId: string | null; packageVersion: string | null; createdAt: number };
  testSuiteId: string | null;
  browsers: BrowserRegressionReport[];
  aggregate: {
    regressionCount: number;
    improvementCount: number;
    scoreDelta: number | null;
    browserSpecificRegressions: string[];
    insufficientData: boolean;
  };
  summary: string;
  generatedAt: number;
}

export interface RegressionRunEvidence {
  browserId: string;
  displayName: string;
  executed: boolean;
  score: number | null;
  packageVersion: string | null;
  createdAt: number;
  results: TestResult[];
  consoleEvents: RuntimeEventLike[];
  network: NetworkEntryLike[];
}

const PASSING_STATES = ["passed", "warning"];
const FAILING_STATES = ["failed", "error", "timeout"];

/** Pure comparison of one browser's previous vs current evidence. */
export function compareBrowserRun(
  browserId: string,
  previous: RegressionRunEvidence | undefined,
  current: RegressionRunEvidence | undefined,
): BrowserRegressionReport {
  const displayName = current?.displayName ?? previous?.displayName ?? browserId;
  const report: BrowserRegressionReport = {
    browserId,
    displayName,
    executed: { previous: Boolean(previous?.executed), current: Boolean(current?.executed) },
    previousScore: previous?.score ?? null,
    currentScore: current?.score ?? null,
    regressions: [],
    improvements: [],
    newRuntimeErrors: [],
    newConsoleErrors: [],
    newNetworkFailures: [],
  };
  if (!previous?.executed || !current?.executed) return report;

  const previousById = new Map(previous.results.map((result) => [result.testId, result]));
  for (const currentResult of current.results) {
    const previousResult = previousById.get(currentResult.testId);
    if (!previousResult) continue;
    const from = previousResult.status;
    const to = currentResult.status;
    if (PASSING_STATES.includes(from) && FAILING_STATES.includes(to)) {
      report.regressions.push({
        testId: currentResult.testId,
        testName: currentResult.name,
        from,
        to,
        kind: "test-regression",
        note: currentResult.errors[0] ?? currentResult.skippedReason,
      });
    } else if (from === "passed" && to === "skipped" && /not supported by the .* runtime|capability/i.test(currentResult.skippedReason ?? "")) {
      report.regressions.push({
        testId: currentResult.testId,
        testName: currentResult.name,
        from,
        to,
        kind: "test-regression",
        note: `Previously passing, now skipped: ${currentResult.skippedReason ?? "capability unavailable"}`,
      });
    } else if (FAILING_STATES.includes(from) && to === "passed") {
      report.improvements.push({
        testId: currentResult.testId,
        testName: currentResult.name,
        from,
        to,
        kind: "test-improvement",
      });
    }
    // FAIL → FAIL intentionally produces no entry: not a new regression.
  }

  // New runtime errors / console errors (by normalized signature).
  const previousErrorSignatures = new Set(
    previous.consoleEvents
      .filter((event) => event.type === "error" || (event.level === "error" && event.type === "console"))
      .map((event) => normalizeErrorSignature(event.message)),
  );
  const previousConsoleSignatures = new Set(
    previous.consoleEvents.filter((event) => event.level === "error").map((event) => normalizeErrorSignature(event.message)),
  );
  for (const event of current.consoleEvents) {
    const signature = normalizeErrorSignature(event.message);
    if (event.type === "error" && !previousErrorSignatures.has(signature) && !report.newRuntimeErrors.includes(event.message.slice(0, 200))) {
      report.newRuntimeErrors.push(event.message.slice(0, 200));
    }
    if (event.level === "error" && !previousConsoleSignatures.has(signature) && !report.newConsoleErrors.includes(event.message.slice(0, 200))) {
      report.newConsoleErrors.push(event.message.slice(0, 200));
    }
  }

  // New network failures (4xx/5xx) by URL.
  const previousFailures = new Set(
    previous.network.filter((entry) => entry.status !== null && entry.status >= 400).map((entry) => `${entry.method} ${entry.url}`),
  );
  for (const entry of current.network) {
    if (entry.status !== null && entry.status >= 400 && !previousFailures.has(`${entry.method} ${entry.url}`)) {
      const label = `${entry.method} ${entry.url} → ${entry.status}`.slice(0, 200);
      if (!report.newNetworkFailures.includes(label)) report.newNetworkFailures.push(label);
    }
  }

  // Lower score is a regression signal of its own.
  if (
    typeof previous.score === "number" &&
    typeof current.score === "number" &&
    current.score < previous.score &&
    report.regressions.length === 0
  ) {
    report.regressions.push({
      testId: "(overall)",
      testName: "Overall score decreased",
      from: String(previous.score),
      to: String(current.score),
      kind: "score-decrease",
    });
  }
  return report;
}

export function buildRegressionComparison(input: {
  previous: { label: string; matrixRunId: string | null; runId: string | null; packageVersion: string | null; createdAt: number; evidence: RegressionRunEvidence[] };
  current: { label: string; matrixRunId: string | null; runId: string | null; packageVersion: string | null; createdAt: number; evidence: RegressionRunEvidence[] };
  testSuiteId: string | null;
}): RegressionComparisonResult {
  const browserIds = new Set<string>([
    ...input.previous.evidence.map((entry) => entry.browserId),
    ...input.current.evidence.map((entry) => entry.browserId),
  ]);
  const browsers = [...browserIds].map((browserId) =>
    compareBrowserRun(
      browserId,
      input.previous.evidence.find((entry) => entry.browserId === browserId),
      input.current.evidence.find((entry) => entry.browserId === browserId),
    ),
  );

  const regressionCount = browsers.reduce((count, browser) => count + browser.regressions.length, 0);
  const improvementCount = browsers.reduce((count, browser) => count + browser.improvements.length, 0);
  const comparableScores = browsers.filter((browser) => browser.previousScore !== null && browser.currentScore !== null);
  const scoreDelta = comparableScores.length
    ? Math.round(
        comparableScores.reduce((sum, browser) => sum + (browser.currentScore! - browser.previousScore!), 0) / comparableScores.length,
      )
    : null;
  const browserSpecificRegressions = browsers
    .filter((browser) => browser.regressions.length > 0 && browsers.some((other) => other.browserId !== browser.browserId && other.regressions.length === 0))
    .map((browser) => browser.browserId);
  const insufficientData = browsers.some((browser) => !browser.executed.previous || !browser.executed.current);

  const summary =
    regressionCount === 0 && improvementCount === 0
      ? insufficientData
        ? "No regressions detected, but some browsers did not execute on both versions, so coverage is incomplete."
        : "No regressions detected between the compared versions."
      : `${regressionCount} regression(s) and ${improvementCount} improvement(s) detected${
          browserSpecificRegressions.length > 0 ? `, including browser-specific regressions in ${browserSpecificRegressions.join(", ")}` : ""
        }.`;

  return {
    schemaVersion: 1,
    previous: {
      label: input.previous.label,
      matrixRunId: input.previous.matrixRunId,
      runId: input.previous.runId,
      packageVersion: input.previous.packageVersion,
      createdAt: input.previous.createdAt,
    },
    current: {
      label: input.current.label,
      matrixRunId: input.current.matrixRunId,
      runId: input.current.runId,
      packageVersion: input.current.packageVersion,
      createdAt: input.current.createdAt,
    },
    testSuiteId: input.testSuiteId,
    browsers,
    aggregate: { regressionCount, improvementCount, scoreDelta, browserSpecificRegressions, insufficientData },
    summary,
    generatedAt: Date.now(),
  };
}

export type { RunOutcome };
