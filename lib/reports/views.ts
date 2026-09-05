import "server-only";
import type { ReportRow } from "@/lib/db/schema/types";

type ReportViewSource = ReportRow & {
  extensionName?: string | null;
  extensionVersion?: string | null;
};

export function createReportView(
  report: ReportViewSource,
  payload: Record<string, unknown> | null,
): Record<string, unknown> {
  const details = payload && typeof payload === "object" ? payload : {};
  const staticAnalysis = details.staticAnalysis as Record<string, unknown> | undefined;
  const runtimeTests = details.runtimeTests as Record<string, unknown> | undefined;

  const issues = Array.isArray((staticAnalysis as { issues?: unknown })?.issues)
    ? ((staticAnalysis as { issues: unknown[] }).issues ?? [])
    : [];
  const tests = runtimeTests ? runtimeTests.details : null;
  const testSummary =
    tests && typeof tests === "object"
      ? ((tests as Record<string, unknown>).summary as Record<string, unknown> | undefined)
      : undefined;

  return {
    report: {
      id: report.id,
      title: report.title,
      summary: report.summary,
      healthScore: report.health_score,
      runtimeScore: report.runtime_score,
      overallScore: report.overall_score,
      createdAt: report.created_at,
      extensionId: report.extension_id,
      analysisSnapshotId: report.analysis_snapshot_id,
      testRunId: report.test_run_id,
    },
    extension: {
      name: report.extensionName,
      version: report.extensionVersion,
    },
    staticAnalysis: {
      healthScore: report.health_score,
      issues,
    },
    runtimeTests: {
      score: report.runtime_score,
      summary: testSummary ?? null,
      // Phase 6: distinguishes "tests ran" from "sandbox never started".
      status: runtimeStatusOf(report, runtimeTests),
      outcome: typeof runtimeTests?.outcome === "string" ? runtimeTests.outcome : null,
      reason: typeof runtimeTests?.reason === "string" ? runtimeTests.reason : null,
    },
    findings: runtimeTests?.details ? extractFindings(runtimeTests.details) : [],
    generatedWith: "ExtensionLab",
  };
}

function runtimeStatusOf(
  report: ReportViewSource,
  runtimeTests: Record<string, unknown> | undefined,
): "executed" | "not-executed" | "none" {
  if (!runtimeTests) return "none";
  if (runtimeTests.runtimeStatus === "not-executed") return "not-executed";
  if (runtimeTests.runtimeStatus === "executed") return "executed";
  // Legacy Phase 5 reports: a stored runtime score means tests executed.
  return report.runtime_score !== null ? "executed" : "not-executed";
}

function extractFindings(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.diagnostics)) return record.diagnostics;
  return [];
}

export function createPublicReportView(
  report: ReportViewSource,
  payload: Record<string, unknown> | null,
): Record<string, unknown> {
  const privateView = createReportView(report, payload) as {
    report: Record<string, unknown>;
    extension: Record<string, unknown>;
    staticAnalysis: Record<string, unknown>;
    runtimeTests: { score: number | null; summary: Record<string, unknown> | null; status: string; outcome: string | null };
    findings: unknown[];
  };
  return {
    title: privateView.report.title ?? "Extension Test Report",
    extension: privateView.extension.name ?? "Browser extension",
    staticScore: privateView.staticAnalysis.healthScore,
    runtimeScore: privateView.runtimeTests.score,
    runtimeStatus: privateView.runtimeTests.status,
    tests: privateView.runtimeTests.status === "executed" ? privateView.runtimeTests.summary : null,
    findings: sanitizeFindings(privateView.findings),
    generatedWith: "ExtensionLab",
  };
}

function sanitizeFindings(findings: unknown[]): unknown[] {
  return findings.map((finding) => {
    if (!finding || typeof finding !== "object") return finding;
    const record = finding as Record<string, unknown>;
    return {
      severity: record.severity,
      category: record.category,
      title: record.title,
      description: record.description,
      recommendation: record.recommendation,
      evidence: Array.isArray(record.evidence) ? record.evidence.slice(0, 6) : [],
    };
  });
}
