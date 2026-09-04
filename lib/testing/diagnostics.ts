import type { DiagnosticFinding, TestResult } from "./types";
import { computeTestScore } from "./scoring";

/**
 * Deterministic diagnostics engine.
 *
 * Findings describe symptoms and offer cautious recommendations; they never
 * claim a root cause that has not been observed, and never invent fixes.
 */
export function generateDiagnostics(results: TestResult[]): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const result of results) {
    if (result.status === "failed") {
      findings.push({
        id: `diag-${result.testId}`,
        severity: "high",
        category: result.category === "security" || result.category === "permissions" ? "security" : result.category,
        title: `${result.name} failed`,
        description: result.errors[0] ?? `Test ${result.name} did not pass.`,
        evidence: result.evidence.slice(0, 3).map((evidence) => evidence.label),
        relatedTestId: result.testId,
        sourceFile: result.evidence.find((evidence) => evidence.detail)?.detail,
        recommendation:
          "Review the reported runtime evidence and verify that the referenced state or file is initialized before use.",
      });
    }

    if (result.status === "warning" && result.warnings.length > 0) {
      findings.push({
        id: `diag-${result.testId}-warning`,
        severity: "medium",
        category: result.category,
        title: `${result.name} needs review`,
        description: result.warnings[0],
        evidence: result.evidence.slice(0, 2).map((evidence) => evidence.label),
        relatedTestId: result.testId,
        recommendation:
          "Review the configuration or permission request to confirm it is required for the intended functionality.",
      });
    }

    if (result.status === "timeout") {
      findings.push({
        id: `diag-${result.testId}-timeout`,
        severity: "high",
        category: "stability",
        title: `${result.name} timed out`,
        description: "The test exceeded its allowed runtime.",
        evidence: result.evidence.map((evidence) => evidence.label),
        relatedTestId: result.testId,
        recommendation:
          "Check for a slow or blocked browser operation during this step.",
      });
    }
  }

  const score = computeTestScore(results);
  if (score.failed > 0 || score.timeout > 0) {
    findings.push({
      id: "diag-run-failures",
      severity: "high",
      category: "report",
      title: "Automated run detected failures",
      description: `${score.failed} failed and ${score.timeout} timed out test(s).`,
      evidence: [`Score ${score.total}/100`],
      recommendation:
        "Address the failed tests before considering the extension runtime-ready.",
    });
  }

  return findings;
}

export function exportTestResults(input: {
  runId: string;
  extensionName?: string;
  extensionVersion?: string;
  results: TestResult[];
  diagnostics: DiagnosticFinding[];
  score: ReturnType<typeof computeTestScore>;
  timestamps: { createdAt: number; startedAt?: number; finishedAt?: number };
}): Record<string, unknown> {
  const summary = {
    passed: input.score.passed,
    failed: input.score.failed,
    warning: input.score.warning,
    skipped: input.score.skipped,
    timeout: input.score.timeout,
    error: input.score.error,
  };
  return {
    report: "ExtensionLab Automated Test Report",
    schemaVersion: 1,
    runId: input.runId,
    extension: {
      name: input.extensionName,
      version: input.extensionVersion,
    },
    score: {
      total: input.score.total,
      categories: input.score.categories,
      basis: input.score.basis,
    },
    summary,
    tests: input.results.map((result) => ({
      testId: result.testId,
      name: result.name,
      status: result.status,
      category: result.category,
      duration: result.duration,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      assertions: result.assertions.map((assertion) => ({
        type: assertion.assertion.type,
        passed: assertion.passed,
        message: assertion.message,
      })),
      evidence: result.evidence.map((evidence) => ({
        kind: evidence.kind,
        label: evidence.label,
      })),
      errors: result.errors,
      warnings: result.warnings,
    })),
    diagnostics: input.diagnostics,
    timestamps: input.timestamps,
  };
}

export function copySummary(input: {
  score: ReturnType<typeof computeTestScore>;
  issues?: string[];
}): string {
  const lines = [
    "ExtensionLab Automated Test Report",
    `Score: ${input.score.total}/100`,
    `${input.score.passed + input.score.failed + input.score.warning + input.score.skipped + input.score.timeout + input.score.error} tests`,
    `${input.score.passed} passed`,
    `${input.score.failed} failed`,
    `${input.score.warning} warning`,
    `${input.score.skipped} skipped`,
  ];
  if (input.issues && input.issues.length > 0) {
    lines.push(`Main issue: ${input.issues[0]}`);
  }
  return lines.join("\n");
}
