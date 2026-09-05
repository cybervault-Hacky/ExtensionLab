import "server-only";
import { summarizeResults } from "./results";
import type { AssertionOutcome, TestResult } from "./types";
import type { RunOutcome } from "@/lib/db/repositories/test-runs";
import type { NetworkEntryLike, RuntimeEventLike } from "./types";

/**
 * Phase 9 deterministic cross-browser comparison.
 *
 * The comparison is computed only from recorded evidence (per-browser test
 * results, runtime events, network entries). Findings are evidence-based and
 * worded carefully: a browser-specific difference is reported as observed
 * behavior, never diagnosed as a browser bug or a root cause.
 */

export type ExecutionOutcome = RunOutcome;

export type CompatibilityFindingType =
  | "BROWSER_ONLY_FAILURE"
  | "UNSUPPORTED_FEATURE"
  | "MANIFEST_COMPATIBILITY_WARNING"
  | "BACKGROUND_MODEL_DIFFERENCE"
  | "POPUP_BEHAVIOR_DIFFERENCE"
  | "NETWORK_STATUS_DIFFERENCE"
  | "CONSOLE_DIFFERENCE"
  | "RUNTIME_ERROR_BROWSER_SPECIFIC"
  | "INFRASTRUCTURE_UNAVAILABLE";

export interface ComparisonFinding {
  type: CompatibilityFindingType;
  title: string;
  description: string;
  browsers: string[];
  testId?: string;
  evidence: string[];
}

export interface CrossBrowserResult {
  browserId: string;
  browserVersion: string | null;
  engine: string | null;
  displayName: string;
  status: ExecutionOutcome;
  executed: boolean;
  score: number;
  passed: number;
  failed: number;
  skipped: number;
  timeout: number;
  error: number;
  runtimeErrors: number;
  consoleErrors: number;
  consoleWarnings: number;
  networkFailures: number;
  screenshots: number;
  durationMs: number | null;
  findings: CompatibilityFindingType[];
}

export interface TestComparisonCell {
  browserId: string;
  status: "passed" | "warning" | "failed" | "skipped" | "timeout" | "error" | "not-run" | "unavailable";
  skippedReason?: string;
  message?: string;
}

export interface TestComparisonRow {
  testId: string;
  name: string;
  category: string;
  cells: Record<string, TestComparisonCell>;
  differs: boolean;
}

export interface NetworkComparisonEntry {
  url: string;
  method: string;
  statuses: Record<string, number | null>;
  resourceType: string;
}

export interface ConsoleComparisonGroup {
  signature: string;
  message: string;
  browsers: string[];
  /** "common" when observed in every executed browser, else "browser-specific". */
  scope: "common" | "browser-specific";
}

export interface CompatibilityScore {
  score: number | null;
  /** executed browsers / requested browsers. */
  coverage: number;
  browsersPassing: string[];
  browsersFailing: string[];
  browsersUnavailable: string[];
  unsupportedTests: number;
  basis: string;
}

export interface MatrixComparison {
  schemaVersion: 1;
  results: CrossBrowserResult[];
  tests: TestComparisonRow[];
  findings: ComparisonFinding[];
  compatibility: CompatibilityScore;
  network: NetworkComparisonEntry[];
  consoleErrors: ConsoleComparisonGroup[];
  generatedAt: number;
}

export interface BrowserExecutionEvidence {
  browserId: string;
  browserVersion: string | null;
  engine: string | null;
  displayName: string;
  executed: boolean;
  outcome: ExecutionOutcome;
  score: number;
  durationMs: number | null;
  results: TestResult[];
  consoleEvents: RuntimeEventLike[];
  network: NetworkEntryLike[];
  screenshotCount: number;
  errorCode?: string | null;
  reason?: string | null;
}

const PASSING: ExecutionOutcome[] = ["PASSED", "WARNING"];
const FAILING: ExecutionOutcome[] = ["FAILED", "TIMEOUT"];
const UNAVAILABLE: ExecutionOutcome[] = ["INFRASTRUCTURE_ERROR", "CANCELLED"];

/** Normalizes an error message into a stable comparison signature. */
export function normalizeErrorSignature(message: string): string {
  return message
    .replace(/[0-9a-f]{8,}/gi, "[id]")
    .replace(/\d+/g, "[n]")
    .replace(/"[^"]{0,80}"/g, "\"…\"")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
    .toLowerCase();
}

function countRuntimeErrors(events: RuntimeEventLike[]): number {
  return events.filter((event) => event.type === "error" || (event.level === "error" && event.type === "console")).length;
}

function countConsole(events: RuntimeEventLike[], level: string): number {
  return events.filter((event) => event.type === "console" && event.level === level).length;
}

function countNetworkFailures(entries: NetworkEntryLike[]): number {
  return entries.filter((entry) => entry.status !== null && entry.status >= 400).length;
}

export function buildMatrixComparison(input: {
  requestedBrowsers: string[];
  executions: BrowserExecutionEvidence[];
  manifestVersion?: "v2" | "v3" | "unknown";
  engineByBrowser: Record<string, string>;
}): MatrixComparison {
  const executionsByBrowser = new Map(input.executions.map((execution) => [execution.browserId, execution]));
  const requested = input.requestedBrowsers;

  // ------------------------------------------------------------------ results
  const results: CrossBrowserResult[] = requested.map((browserId) => {
    const execution = executionsByBrowser.get(browserId);
    if (!execution || !execution.executed) {
      const outcome: ExecutionOutcome = execution?.outcome ?? "INFRASTRUCTURE_ERROR";
      return {
        browserId,
        browserVersion: execution?.browserVersion ?? null,
        engine: input.engineByBrowser[browserId] ?? null,
        displayName: execution?.displayName ?? browserId,
        status: outcome,
        executed: false,
        score: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        timeout: 0,
        error: 0,
        runtimeErrors: 0,
        consoleErrors: 0,
        consoleWarnings: 0,
        networkFailures: 0,
        screenshots: 0,
        durationMs: null,
        findings: [],
      };
    }
    const summary = summarizeResults(execution.results);
    return {
      browserId,
      browserVersion: execution.browserVersion,
      engine: input.engineByBrowser[browserId] ?? null,
      displayName: execution.displayName,
      status: execution.outcome,
      executed: true,
      score: execution.score,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      timeout: summary.timeout,
      error: summary.error,
      runtimeErrors: countRuntimeErrors(execution.consoleEvents),
      consoleErrors: countConsole(execution.consoleEvents, "error"),
      consoleWarnings: countConsole(execution.consoleEvents, "warning"),
      networkFailures: countNetworkFailures(execution.network),
      screenshots: execution.screenshotCount,
      durationMs: execution.durationMs,
      findings: [],
    };
  });

  // -------------------------------------------------------------------- tests
  const executedExecutions = input.executions.filter((execution) => execution.executed);
  const allTestIds = new Set<string>();
  for (const execution of executedExecutions) {
    for (const result of execution.results) allTestIds.add(result.testId);
  }
  const tests: TestComparisonRow[] = [];
  const testFindings: ComparisonFinding[] = [];
  for (const testId of allTestIds) {
    const row: TestComparisonRow = { testId, name: testId, category: "", cells: {}, differs: false };
    const statuses = new Set<string>();
    for (const browserId of requested) {
      const execution = executionsByBrowser.get(browserId);
      if (!execution) continue;
      const result = execution.results.find((entry) => entry.testId === testId);
      if (!execution.executed) {
        row.cells[browserId] = { browserId, status: UNAVAILABLE.includes(execution.outcome) ? "unavailable" : "not-run" };
        continue;
      }
      if (!result) {
        row.cells[browserId] = { browserId, status: "not-run" };
        continue;
      }
      row.name = result.name;
      row.category = result.category;
      statuses.add(result.status);
      const cell: TestComparisonCell = { browserId, status: result.status as TestComparisonCell["status"] };
      if (result.skippedReason) cell.skippedReason = result.skippedReason;
      const firstError = result.errors[0];
      if (firstError) cell.message = firstError;
      row.cells[browserId] = cell;
    }
    row.differs = statuses.size > 1;
    tests.push(row);

    // Evidence-based findings per test row.
    const failingBrowsers = requested.filter((browserId) => ["failed", "timeout", "error"].includes(row.cells[browserId]?.status ?? ""));
    const passingBrowsers = requested.filter((browserId) => ["passed", "warning"].includes(row.cells[browserId]?.status ?? ""));
    const unsupportedBrowsers = requested.filter(
      (browserId) => row.cells[browserId]?.status === "skipped" && /not supported by the .* runtime|requires a capability/i.test(row.cells[browserId]?.skippedReason ?? ""),
    );

    if (failingBrowsers.length > 0 && passingBrowsers.length > 0 && failingBrowsers.length === 1) {
      testFindings.push({
        type: "BROWSER_ONLY_FAILURE",
        title: "Cross-browser compatibility issue detected.",
        description: `Test "${row.name}" passes in ${describeBrowsers(passingBrowsers, executionsByBrowser)} but fails in ${describeBrowsers(failingBrowsers, executionsByBrowser)}. Browser-specific failure detected.`,
        browsers: failingBrowsers,
        testId,
        evidence: failingBrowsers
          .map((browserId) => `${executionsByBrowser.get(browserId)?.displayName ?? browserId}: ${row.cells[browserId]?.message ?? row.cells[browserId]?.skippedReason ?? "failed"}`)
          .slice(0, 4),
      });
    }
    if (unsupportedBrowsers.length > 0) {
      testFindings.push({
        type: "UNSUPPORTED_FEATURE",
        title: "Unsupported in one or more browsers.",
        description: `Test "${row.name}" could not be executed in ${describeBrowsers(unsupportedBrowsers, executionsByBrowser)} because a required capability is not supported by that runtime. It is reported as skipped, not failed.`,
        browsers: unsupportedBrowsers,
        testId,
        evidence: unsupportedBrowsers.map((browserId) => row.cells[browserId]?.skippedReason ?? "").filter(Boolean),
      });
    }
    if (row.category === "popup" && row.differs) {
      testFindings.push({
        type: "POPUP_BEHAVIOR_DIFFERENCE",
        title: "Popup behavior differs across browsers.",
        description: `Popup test "${row.name}" produced different results across browsers: ${requested
          .map((browserId) => `${browserId}=${row.cells[browserId]?.status ?? "not-run"}`)
          .join(", ")}.`,
        browsers: requested.filter((browserId) => row.cells[browserId]),
        testId,
        evidence: [],
      });
    }
    if (
      row.testId === "service-worker" &&
      input.manifestVersion === "v3" &&
      requested.includes("firefox") &&
      ["skipped", "failed", "timeout"].includes(row.cells.firefox?.status ?? "")
    ) {
      testFindings.push({
        type: "BACKGROUND_MODEL_DIFFERENCE",
        title: "Background execution model difference.",
        description:
          "Firefox runs Manifest V3 background execution as a non-persistent event page rather than a service worker, so service-worker lifecycle evidence differs by design. Verify background behavior manually in Firefox if it matters for your extension.",
        browsers: ["firefox"],
        testId,
        evidence: [row.cells.firefox?.skippedReason ?? row.cells.firefox?.message ?? ""].filter(Boolean),
      });
    }
  }

  // ------------------------------------------------------------------ network
  const network = buildNetworkComparison(requested, executedExecutions);
  const networkFindings: ComparisonFinding[] = [];
  for (const entry of network) {
    const statuses = new Set(Object.values(entry.statuses).filter((status): status is number => status !== null));
    if (statuses.size > 1) {
      const browsers = Object.keys(entry.statuses);
      networkFindings.push({
        type: "NETWORK_STATUS_DIFFERENCE",
        title: "Network response status differs across browsers.",
        description: `The request to ${entry.url} returned different statuses: ${browsers
          .map((browserId) => `${browserId}=${entry.statuses[browserId] ?? "n/a"}`)
          .join(", ")}.`,
        browsers,
        evidence: [entry.url],
      });
    }
  }

  // ------------------------------------------------------------------ console
  const consoleErrors = buildConsoleComparison(requested, executedExecutions);
  const consoleFindings: ComparisonFinding[] = consoleErrors
    .filter((group) => group.scope === "browser-specific")
    .map((group) => ({
      type: "CONSOLE_DIFFERENCE",
      title: "Console errors appear only in some browsers.",
      description: `Error "${group.message}" was captured in ${group.browsers.join(", ")} but not in the other executed browsers.`,
      browsers: group.browsers,
      evidence: [group.message],
    }));

  // ------------------------------------------------- runtime error comparison
  const runtimeFindings: ComparisonFinding[] = [];
  const signatureBrowsers = new Map<string, string[]>();
  for (const execution of executedExecutions) {
    for (const event of execution.consoleEvents) {
      if (event.type !== "error" && !(event.level === "error" && event.type === "console")) continue;
      const signature = normalizeErrorSignature(event.message);
      const browsers = signatureBrowsers.get(signature) ?? [];
      if (!browsers.includes(execution.browserId)) browsers.push(execution.browserId);
      signatureBrowsers.set(signature, browsers);
    }
  }
  const executedBrowserIds = executedExecutions.map((execution) => execution.browserId);
  for (const [signature, browsers] of signatureBrowsers) {
    if (browsers.length > 0 && browsers.length < executedBrowserIds.length) {
      runtimeFindings.push({
        type: "RUNTIME_ERROR_BROWSER_SPECIFIC",
        title: "Browser-specific runtime error candidate.",
        description: `A runtime error (signature "${signature}") was captured only in ${browsers.join(", ")}. This is a candidate browser-specific issue; the recorded evidence does not identify a root cause.`,
        browsers,
        evidence: [],
      });
    }
  }

  // ---------------------------------------------------- unavailable browsers
  const unavailableBrowsers = results.filter((result) => UNAVAILABLE.includes(result.status)).map((result) => result.browserId);
  const infraFindings: ComparisonFinding[] = unavailableBrowsers.map((browserId) => ({
    type: "INFRASTRUCTURE_UNAVAILABLE",
    title: "Insufficient execution data for one browser.",
    description: `The ${executionsByBrowser.get(browserId)?.displayName ?? browserId} execution did not run because of an infrastructure problem (${executionsByBrowser.get(browserId)?.errorCode ?? "unknown"}). This is not counted as an extension failure, and the compatibility score excludes it from its basis.`,
    browsers: [browserId],
    evidence: [executionsByBrowser.get(browserId)?.reason ?? ""].filter(Boolean),
  }));

  // -------------------------------------------------------------------- score
  const executedResults = results.filter((result) => result.executed);
  const browsersPassing = executedResults.filter((result) => PASSING.includes(result.status)).map((result) => result.browserId);
  const browsersFailing = executedResults.filter((result) => FAILING.includes(result.status)).map((result) => result.browserId);
  const browsersUnavailable = results.filter((result) => !result.executed).map((result) => result.browserId);
  const unsupportedTests = tests.reduce(
    (count, row) =>
      count +
      (requested.some((browserId) => row.cells[browserId]?.status === "skipped" && /capability|not supported by the .* runtime/i.test(row.cells[browserId]?.skippedReason ?? "")) ? 1 : 0),
    0,
  );
  const coverage = requested.length === 0 ? 0 : executedResults.length / requested.length;
  const score =
    executedResults.length === 0
      ? null
      : Math.round((100 * browsersPassing.length) / executedResults.length);

  const compatibility: CompatibilityScore = {
    score,
    coverage: Math.round(coverage * 100) / 100,
    browsersPassing,
    browsersFailing,
    browsersUnavailable,
    unsupportedTests,
    basis:
      executedResults.length === 0
        ? "No browser executed any tests, so no compatibility score is computed (insufficient execution data)."
        : `Compatibility score = share of executed browsers whose outcome passed (warnings count as passing): ${browsersPassing.length}/${executedResults.length}. Infrastructure failures (${browsersUnavailable.length}) are excluded from the basis and reported as unavailable instead — they do not reduce the extension's compatibility score. Coverage = executed/requested browsers = ${executedResults.length}/${requested.length}. The score is deterministic.`,
  };

  const findings = [...testFindings, ...networkFindings, ...consoleFindings, ...runtimeFindings, ...infraFindings];
  const findingsByBrowser = new Map<string, CompatibilityFindingType[]>();
  for (const finding of findings) {
    for (const browserId of finding.browsers) {
      const list = findingsByBrowser.get(browserId) ?? [];
      if (!list.includes(finding.type)) list.push(finding.type);
      findingsByBrowser.set(browserId, list);
    }
  }
  for (const result of results) {
    result.findings = findingsByBrowser.get(result.browserId) ?? [];
  }

  return {
    schemaVersion: 1,
    results,
    tests,
    findings,
    compatibility,
    network,
    consoleErrors,
    generatedAt: Date.now(),
  };
}

function describeBrowsers(browserIds: string[], executions: Map<string, BrowserExecutionEvidence>): string {
  return browserIds.map((id) => executions.get(id)?.displayName ?? id).join(", ");
}

function buildNetworkComparison(requested: string[], executions: BrowserExecutionEvidence[]): NetworkComparisonEntry[] {
  const byUrlMethod = new Map<string, NetworkComparisonEntry>();
  for (const execution of executions) {
    for (const entry of execution.network.slice(0, 100)) {
      const key = `${entry.method === "RESPONSE" ? "GET" : entry.method} ${entry.url}`;
      const comparison = byUrlMethod.get(key) ?? {
        url: entry.url,
        method: entry.method === "RESPONSE" ? "GET" : entry.method,
        statuses: {},
        resourceType: entry.resourceType,
      };
      if (entry.status !== null && entry.status !== undefined) {
        comparison.statuses[execution.browserId] = entry.status;
      } else if (comparison.statuses[execution.browserId] === undefined) {
        comparison.statuses[execution.browserId] = null;
      }
      byUrlMethod.set(key, comparison);
    }
  }
  return [...byUrlMethod.values()].filter((entry) => Object.keys(entry.statuses).length > 0).slice(0, 50);
}

function buildConsoleComparison(requested: string[], executions: BrowserExecutionEvidence[]): ConsoleComparisonGroup[] {
  const bySignature = new Map<string, ConsoleComparisonGroup>();
  for (const execution of executions) {
    const seen = new Set<string>();
    for (const event of execution.consoleEvents) {
      if (event.level !== "error") continue;
      const signature = normalizeErrorSignature(event.message);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const group = bySignature.get(signature) ?? {
        signature,
        message: event.message.slice(0, 200),
        browsers: [],
        scope: "browser-specific",
      };
      if (!group.browsers.includes(execution.browserId)) group.browsers.push(execution.browserId);
      bySignature.set(signature, group);
    }
  }
  const executedCount = executions.length;
  for (const group of bySignature.values()) {
    group.scope = group.browsers.length >= executedCount && executedCount > 0 ? "common" : "browser-specific";
  }
  return [...bySignature.values()].slice(0, 30);
}

/** Count of assertion outcomes that were skipped for capability reasons. */
export function countUnsupportedAssertions(assertions: AssertionOutcome[]): number {
  return assertions.filter((outcome) => outcome.skipped === true).length;
}
