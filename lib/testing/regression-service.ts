import "server-only";
import { getDb, transaction } from "@/lib/db/client";
import { getOwnedMatrixRun, listCompletedMatrixRunsForExtension, listExecutionsForMatrix } from "@/lib/db/repositories/browser-matrix";
import { getBaselineForExtension } from "@/lib/db/repositories/baselines";
import { getOwnedTestRun, getTestRunById } from "@/lib/db/repositories/test-runs";
import { getOwnedPackage } from "@/lib/db/repositories/packages";
import { createRegressionComparisonRow, getOwnedRegressionComparison } from "@/lib/db/repositories/regressions";
import { canUseRegressionTesting } from "@/lib/billing/entitlements";
import { getBrowserProfile } from "@/lib/browsers/registry";
import type { BrowserId } from "@/lib/browsers/types";
import { buildRegressionComparison, type RegressionComparisonResult, type RegressionRunEvidence } from "./regression";
import type { NetworkEntryLike, RuntimeEventLike, TestResult } from "./types";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";

/**
 * Regression service: assembles per-browser evidence from stored runs/matrix
 * runs, computes the deterministic comparison and persists it. Baselines pin
 * exact package versions — the "previous" side is either an explicitly
 * designated baseline or an explicitly provided run/matrix id, never an
 * implicit "latest".
 */

interface ParsedRunJson {
  results?: TestResult[];
}

function evidenceFromRun(runId: string, browserId: BrowserId | null): RegressionRunEvidence | null {
  const run = getTestRunById(runId);
  if (!run) return null;
  const id = (browserId ?? (run.browser_id as BrowserId | null) ?? "chromium") as BrowserId;
  const parsed = run.result_json ? (JSON.parse(run.result_json) as ParsedRunJson) : null;
  const events = run.events_json ? (JSON.parse(run.events_json) as string[]) : [];
  const consoleEvents: RuntimeEventLike[] = [];
  for (const raw of events.slice(-200)) {
    try {
      const parsedEvent = JSON.parse(raw) as Record<string, unknown>;
      // Only sandbox/console evidence rows carry runtime events; test-engine
      // state events are objects without `type`/`level`/`message` triplets.
      if (
        typeof parsedEvent.type === "string" &&
        typeof parsedEvent.level === "string" &&
        typeof parsedEvent.message === "string" &&
        ["console", "error"].includes(parsedEvent.type)
      ) {
        consoleEvents.push({
          id: String(parsedEvent.id ?? ""),
          timestamp: Number(parsedEvent.timestamp ?? 0),
          type: String(parsedEvent.type),
          level: String(parsedEvent.level),
          source: String(parsedEvent.source ?? ""),
          message: String(parsedEvent.message),
        });
      }
    } catch {
      // Ignore malformed rows.
    }
  }
  const executed =
    Boolean(run.outcome) &&
    run.outcome !== "INFRASTRUCTURE_ERROR" &&
    run.outcome !== "CANCELLED" &&
    !["failed", "timeout", "destroyed"].includes(run.status);
  return {
    browserId: id,
    displayName: getBrowserProfile(id)?.displayName ?? id,
    executed,
    score: run.score ?? null,
    packageVersion: run.package_id ? (getOwnedPackage(run.user_id, run.package_id)?.version ?? null) : null,
    createdAt: run.created_at,
    results: parsed?.results ?? [],
    consoleEvents,
    network: [],
  };
}

interface SideInput {
  matrixRunId?: string | null;
  runId?: string | null;
}

interface Side {
  label: string;
  matrixRunId: string | null;
  runId: string | null;
  packageVersion: string | null;
  createdAt: number;
  suiteId: string | null;
  evidence: RegressionRunEvidence[];
}

function loadSide(userId: string, side: SideInput, name: "previous" | "current"): Side {
  if (side.matrixRunId) {
    const matrix = getOwnedMatrixRun(userId, side.matrixRunId);
    if (!matrix) throw new AppError("NOT_FOUND", { message: `The ${name} matrix run was not found.` });
    if (!["completed", "partial"].includes(matrix.status)) {
      throw new AppError("CONFLICT", { message: `The ${name} matrix run has not finished yet.` });
    }
    const evidence: RegressionRunEvidence[] = [];
    for (const execution of listExecutionsForMatrix(matrix.id)) {
      const entry = evidenceFromRun(execution.test_run_id, execution.browser_id as BrowserId);
      if (entry) {
        // Prefer the execution's redacted evidence JSON for network coverage.
        if (execution.evidence_json) {
          try {
            const parsed = JSON.parse(execution.evidence_json) as { network?: NetworkEntryLike[]; consoleEvents?: RuntimeEventLike[] };
            entry.network = parsed.network ?? [];
            if (parsed.consoleEvents) entry.consoleEvents = parsed.consoleEvents;
          } catch {
            // Fall back to the run's persisted events.
          }
        }
        evidence.push(entry);
      }
    }
    return {
      label: `Matrix ${matrix.id}`,
      matrixRunId: matrix.id,
      runId: null,
      packageVersion: getOwnedPackage(userId, matrix.package_id)?.version ?? null,
      createdAt: matrix.created_at,
      suiteId: matrix.test_suite_id,
      evidence,
    };
  }
  if (side.runId) {
    const run = getOwnedTestRun(userId, side.runId);
    if (!run) throw new AppError("NOT_FOUND", { message: `The ${name} test run was not found.` });
    if (!["completed", "timeout"].includes(run.status)) {
      throw new AppError("CONFLICT", { message: `The ${name} run has not finished yet.` });
    }
    const entry = evidenceFromRun(run.id, null);
    return {
      label: `Run ${run.id}`,
      matrixRunId: null,
      runId: run.id,
      packageVersion: run.package_id ? (getOwnedPackage(userId, run.package_id)?.version ?? null) : null,
      createdAt: run.created_at,
      suiteId: null,
      evidence: entry ? [entry] : [],
    };
  }
  throw new AppError("INVALID_INPUT", { message: `Provide a ${name} run or matrix run id.` });
}

export function compareForRegression(input: {
  userId: string;
  previous: SideInput;
  current: SideInput;
  persist?: boolean;
}): { comparisonId: string | null; result: RegressionComparisonResult } {
  const entitlement = canUseRegressionTesting(input.userId);
  if (!entitlement.allowed) {
    throw new AppError("PAYMENT_REQUIRED", {
      message: entitlement.reason === "plan" ? entitlement.message : undefined,
    });
  }
  if (
    (input.previous.matrixRunId && input.current.matrixRunId && input.previous.matrixRunId === input.current.matrixRunId) ||
    (input.previous.runId && input.current.runId && input.previous.runId === input.current.runId)
  ) {
    throw new AppError("INVALID_INPUT", { message: "Select two different runs to compare." });
  }
  const previous = loadSide(input.userId, input.previous, "previous");
  const current = loadSide(input.userId, input.current, "current");
  const result = buildRegressionComparison({
    previous: {
      label: previous.label,
      matrixRunId: previous.matrixRunId,
      runId: previous.runId,
      packageVersion: previous.packageVersion,
      createdAt: previous.createdAt,
      evidence: previous.evidence,
    },
    current: {
      label: current.label,
      matrixRunId: current.matrixRunId,
      runId: current.runId,
      packageVersion: current.packageVersion,
      createdAt: current.createdAt,
      evidence: current.evidence,
    },
    testSuiteId: previous.suiteId ?? current.suiteId,
  });

  let comparisonId: string | null = null;
  if (input.persist !== false) {
    const row = transaction(getDb(), () =>
      createRegressionComparisonRow({
        userId: input.userId,
        extensionId: null,
        packageVersionIdPrev: previous.packageVersion,
        packageVersionIdCurrent: current.packageVersion,
        testSuiteId: result.testSuiteId,
        browsers: [...new Set([...previous.evidence.map((e) => e.browserId), ...current.evidence.map((e) => e.browserId)])],
        previousMatrixRunId: previous.matrixRunId,
        currentMatrixRunId: current.matrixRunId,
        previousRunId: previous.runId,
        currentRunId: current.runId,
        resultJson: JSON.stringify(result),
        regressionCount: result.aggregate.regressionCount,
        improvementCount: result.aggregate.improvementCount,
      }),
    );
    comparisonId = row.id;
  }
  recordMetric("regression.compared", 1, { regressions: String(result.aggregate.regressionCount) });
  logger.info("regression.compared", {
    userId: input.userId,
    comparisonId: comparisonId ?? undefined,
    regressions: result.aggregate.regressionCount,
    improvements: result.aggregate.improvementCount,
  });
  return { comparisonId, result };
}

export function getRegressionResult(userId: string, comparisonId: string): RegressionComparisonResult | null {
  const row = getOwnedRegressionComparison(userId, comparisonId);
  if (!row) return null;
  try {
    return JSON.parse(row.result_json) as RegressionComparisonResult;
  } catch {
    return null;
  }
}

/** Resolves the designated baseline matrix/run for an extension, if any. */
export function resolveBaselineSide(userId: string, extensionId: string | null): SideInput | null {
  if (!extensionId) return null;
  const baseline = getBaselineForExtension(userId, extensionId);
  if (!baseline) return null;
  if (baseline.matrix_run_id) return { matrixRunId: baseline.matrix_run_id };
  if (baseline.run_id) return { runId: baseline.run_id };
  return null;
}

/** Most recent finished matrix run for an extension, excluding `excludeId`. */
export function latestFinishedMatrixForExtension(userId: string, extensionId: string | null, excludeId?: string): SideInput | null {
  if (!extensionId) return null;
  const candidates = listCompletedMatrixRunsForExtension(extensionId).filter((row) => row.user_id === userId && row.id !== excludeId);
  return candidates.length > 0 ? { matrixRunId: candidates[0].id } : null;
}
