import "server-only";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/observability/errors";
import { recordAuditEvent } from "@/lib/audit/service";
import { getMembership, getPolicy, upsertPolicyRow } from "@/lib/organizations/repository";
import type { BrowserMatrixRunRow } from "@/lib/db/schema/types";

/**
 * Organization CI quality gates (Phase 10).
 *
 * Rules are stored server-side and evaluated deterministically from stored
 * evidence (analysis findings, run results, matrix executions, regression
 * state). A client can never mark a failed run as passed: the verdict is
 * always recomputed here. An infrastructure failure is never a PASS.
 */

export interface PolicyRules {
  minHealthScore?: number | null;
  maxCriticalFindings?: number | null;
  maxHighFindings?: number | null;
  requiredTestIds?: string[] | null;
  requiredBrowsers?: string[] | null;
  allowRegressions?: boolean;
}

export interface PolicyCheck {
  id: string;
  label: string;
  pass: boolean;
  /** "not_evaluated" when no evidence existed for this check. */
  status: "pass" | "fail" | "not_evaluated";
  detail: string;
}

export interface PolicyEvaluation {
  result: "PASS" | "FAIL" | "NOT_EVALUATED";
  checks: PolicyCheck[];
  evaluatedAt: number;
}

export interface PolicyEvidence {
  analysis?: {
    healthScore: number | null;
    criticalFindings: number;
    highFindings: number;
  } | null;
  testRun?: {
    outcome: string | null;
    status: string;
    failedTestIds: string[];
    skippedTestIds: string[];
    executedTestIds: string[];
  } | null;
  browserMatrix?: {
    status: string;
    compatibilityScore: number | null;
    executions: Array<{ browserId: string; outcome: string | null; status: string }>;
  } | null;
  regression?: {
    regressionCount: number;
  } | null;
  infrastructureFailed?: boolean;
}

const RULE_BOUNDS = {
  minHealthScore: { min: 0, max: 100 },
  maxCriticalFindings: { min: 0, max: 100 },
  maxHighFindings: { min: 0, max: 100 },
};

function normalizeRules(raw: unknown): PolicyRules {
  if (raw === null || raw === undefined || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const rules: PolicyRules = {};
  const intOrNull = (key: keyof typeof RULE_BOUNDS): number | null => {
    const value = input[key];
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return null;
    const bounds = RULE_BOUNDS[key];
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
  };
  rules.minHealthScore = intOrNull("minHealthScore");
  rules.maxCriticalFindings = intOrNull("maxCriticalFindings");
  rules.maxHighFindings = intOrNull("maxHighFindings");
  if (Array.isArray(input.requiredTestIds)) {
    rules.requiredTestIds = input.requiredTestIds.filter((id): id is string => typeof id === "string").slice(0, 32);
  }
  if (Array.isArray(input.requiredBrowsers)) {
    const allowed = ["chromium", "edge", "firefox"];
    rules.requiredBrowsers = input.requiredBrowsers.filter((id): id is string => typeof id === "string" && allowed.includes(id)).slice(0, 3);
  }
  if (typeof input.allowRegressions === "boolean") rules.allowRegressions = input.allowRegressions;
  return rules;
}

export function getOrganizationPolicyRules(organizationId: string): PolicyRules | null {
  const row = getPolicy(organizationId);
  if (!row) return null;
  try {
    return normalizeRules(JSON.parse(row.rules_json));
  } catch {
    return {};
  }
}

export function updateOrganizationPolicy(ctx: { userId: string; organizationId: string; requestId?: string | null }, rules: unknown, name?: string): PolicyRules {
  const actor = getMembership(ctx.organizationId, ctx.userId);
  if (!actor || (actor.role !== "owner" && actor.role !== "admin" && actor.role !== "developer")) throw new AppError("ROLE_REQUIRED");
  const normalized = normalizeRules(rules);
  upsertPolicyRow({ organizationId: ctx.organizationId, name: (name ?? "Quality gates").slice(0, 80), rulesJson: JSON.stringify(normalized), createdBy: ctx.userId });
  recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "policy.updated", resourceType: "policy", resourceId: ctx.organizationId, requestId: ctx.requestId, metadata: { rules: JSON.stringify(normalized).slice(0, 200) } });
  return normalized;
}

/**
 * Deterministic policy evaluation. Rules with no matching evidence mark their
 * check `not_evaluated`; the overall verdict is FAIL if any check failed,
 * NOT_EVALUATED if no check could run, PASS only when every applicable check
 * genuinely passed.
 */
export function evaluatePolicy(rules: PolicyRules, evidence: PolicyEvidence): PolicyEvaluation {
  const checks: PolicyCheck[] = [];

  if (rules.minHealthScore !== null && rules.minHealthScore !== undefined) {
    const score = evidence.analysis?.healthScore ?? null;
    checks.push(
      score === null
        ? { id: "min-health-score", label: `Health score ≥ ${rules.minHealthScore}`, pass: false, status: "not_evaluated", detail: "No analysis was available to evaluate." }
        : {
            id: "min-health-score",
            label: `Health score ≥ ${rules.minHealthScore}`,
            pass: score >= rules.minHealthScore,
            status: score >= rules.minHealthScore ? "pass" : "fail",
            detail: `Health score is ${score}.`,
          },
    );
  }

  if (rules.maxCriticalFindings !== null && rules.maxCriticalFindings !== undefined) {
    const count = evidence.analysis?.criticalFindings ?? null;
    checks.push(
      count === null
        ? { id: "max-critical-findings", label: `Critical findings ≤ ${rules.maxCriticalFindings}`, pass: false, status: "not_evaluated", detail: "No analysis was available to evaluate." }
        : {
            id: "max-critical-findings",
            label: `Critical findings ≤ ${rules.maxCriticalFindings}`,
            pass: count <= rules.maxCriticalFindings,
            status: count <= rules.maxCriticalFindings ? "pass" : "fail",
            detail: `${count} critical finding(s).`,
          },
    );
  }

  if (rules.maxHighFindings !== null && rules.maxHighFindings !== undefined) {
    const count = evidence.analysis?.highFindings ?? null;
    checks.push(
      count === null
        ? { id: "max-high-findings", label: `High findings ≤ ${rules.maxHighFindings}`, pass: false, status: "not_evaluated", detail: "No analysis was available to evaluate." }
        : {
            id: "max-high-findings",
            label: `High findings ≤ ${rules.maxHighFindings}`,
            pass: count <= rules.maxHighFindings,
            status: count <= rules.maxHighFindings ? "pass" : "fail",
            detail: `${count} high finding(s).`,
          },
    );
  }

  if (rules.requiredTestIds && rules.requiredTestIds.length > 0) {
    const run = evidence.testRun ?? null;
    if (!run) {
      checks.push({ id: "required-tests", label: "Required tests pass", pass: false, status: "not_evaluated", detail: "No test run was available to evaluate." });
    } else {
      const missing: string[] = [];
      const failing: string[] = [];
      for (const testId of rules.requiredTestIds) {
        if (!run.executedTestIds.includes(testId)) missing.push(testId);
        else if (run.failedTestIds.includes(testId)) failing.push(testId);
      }
      const pass = missing.length === 0 && failing.length === 0;
      checks.push({
        id: "required-tests",
        label: "Required tests pass",
        pass,
        status: pass ? "pass" : "fail",
        detail: missing.length > 0 ? `Not executed: ${missing.join(", ")}` : failing.length > 0 ? `Failed: ${failing.join(", ")}` : `All ${rules.requiredTestIds.length} required test(s) passed.`,
      });
    }
  }

  if (rules.requiredBrowsers && rules.requiredBrowsers.length > 0) {
    const matrix = evidence.browserMatrix ?? null;
    if (!matrix) {
      checks.push({ id: "required-browsers", label: `Required browsers pass (${rules.requiredBrowsers.join(", ")})`, pass: false, status: "not_evaluated", detail: "No browser matrix was available to evaluate." });
    } else {
      const failures: string[] = [];
      for (const browserId of rules.requiredBrowsers) {
        const execution = matrix.executions.find((entry) => entry.browserId === browserId);
        if (!execution) {
          failures.push(`${browserId}: not executed`);
          continue;
        }
        // Infrastructure failures and skips are never a PASS.
        if (execution.outcome === "INFRASTRUCTURE_ERROR" || execution.outcome === "CANCELLED") {
          failures.push(`${browserId}: infrastructure unavailable`);
        } else if (execution.outcome !== "PASSED" && execution.outcome !== "WARNING") {
          failures.push(`${browserId}: ${execution.outcome?.toLowerCase() ?? "failed"}`);
        }
      }
      const pass = failures.length === 0;
      checks.push({
        id: "required-browsers",
        label: `Required browsers pass (${rules.requiredBrowsers.join(", ")})`,
        pass,
        status: pass ? "pass" : "fail",
        detail: pass ? `All required browsers passed.` : failures.join("; "),
      });
    }
  }

  if (rules.allowRegressions === false) {
    const regression = evidence.regression ?? null;
    if (!regression) {
      checks.push({ id: "regressions", label: "No regressions", pass: false, status: "not_evaluated", detail: "No regression comparison was available to evaluate." });
    } else {
      const pass = regression.regressionCount === 0;
      checks.push({ id: "regressions", label: "No regressions", pass, status: pass ? "pass" : "fail", detail: `${regression.regressionCount} regression(s) detected.` });
    }
  }

  if (checks.length === 0) {
    return { result: "NOT_EVALUATED", checks: [], evaluatedAt: Date.now() };
  }
  if (evidence.infrastructureFailed === true) {
    // An infrastructure failure can never produce a PASS verdict.
    return {
      result: "FAIL",
      checks: [
        ...checks,
        { id: "infrastructure", label: "Test infrastructure available", pass: false, status: "fail", detail: "The test infrastructure failed; the quality gates cannot pass." },
      ],
      evaluatedAt: Date.now(),
    };
  }
  const anyFail = checks.some((check) => check.status === "fail");
  const anyEvaluated = checks.some((check) => check.status !== "not_evaluated");
  return { result: anyFail ? "FAIL" : anyEvaluated ? "PASS" : "NOT_EVALUATED", checks, evaluatedAt: Date.now() };
}

/** Assembles evidence from stored rows for a matrix run (server-side only). */
export function evidenceForMatrixRun(matrix: BrowserMatrixRunRow): PolicyEvidence {
  const db = getDb();
  const executions = db
    .prepare("SELECT browser_id, outcome, status FROM browser_matrix_executions WHERE matrix_run_id = ?")
    .all(matrix.id) as unknown as Array<{ browser_id: string; outcome: string | null; status: string }>;
  const packageRow = db
    .prepare("SELECT extension_id FROM extension_packages WHERE id = ?")
    .get(matrix.package_id) as { extension_id: string | null } | undefined;
  let analysis: PolicyEvidence["analysis"] = null;
  if (packageRow?.extension_id) {
    const snapshot = db
      .prepare("SELECT analysis_json FROM analysis_snapshots WHERE extension_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(packageRow.extension_id) as { analysis_json: string } | undefined;
    if (snapshot) {
      try {
        const parsed = JSON.parse(snapshot.analysis_json) as { healthScore?: { total?: number }; issues?: Array<{ severity?: string }> };
        analysis = {
          healthScore: typeof parsed.healthScore?.total === "number" ? parsed.healthScore.total : null,
          criticalFindings: (parsed.issues ?? []).filter((issue) => issue.severity === "critical").length,
          highFindings: (parsed.issues ?? []).filter((issue) => issue.severity === "high").length,
        };
      } catch {
        analysis = null;
      }
    }
  }
  const runRows = db
    .prepare("SELECT outcome, status, result_json FROM test_runs WHERE matrix_run_id = ? ORDER BY created_at ASC")
    .all(matrix.id) as unknown as Array<{ outcome: string | null; status: string; result_json: string | null }>;
  const executedTestIds: string[] = [];
  const failedTestIds: string[] = [];
  for (const row of runRows) {
    if (!row.result_json) continue;
    try {
      const parsed = JSON.parse(row.result_json) as { results?: Array<{ testId: string; status: string }> };
      for (const result of parsed.results ?? []) {
        executedTestIds.push(result.testId);
        if (result.status === "failed" || result.status === "error") failedTestIds.push(result.testId);
      }
    } catch {
      // ignore malformed rows
    }
  }
  return {
    analysis,
    testRun: runRows.length
      ? { outcome: runRows[0].outcome, status: runRows[0].status, failedTestIds, skippedTestIds: [], executedTestIds }
      : null,
    browserMatrix: {
      status: matrix.status,
      compatibilityScore: matrix.compatibility_score,
      executions: executions.map((row) => ({ browserId: row.browser_id, outcome: row.outcome, status: row.status })),
    },
    infrastructureFailed: runRows.some((row) => row.outcome === "INFRASTRUCTURE_ERROR") || executions.some((row) => row.outcome === "INFRASTRUCTURE_ERROR"),
  };
}
