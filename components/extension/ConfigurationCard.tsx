"use client";

import { StatusBadge } from "@/components/ui/StatusBadge";
import type { AnalyzerIssue, ExtensionAnalysis } from "@/types/extension";

export function ConfigurationCard({
  analysis,
}: {
  analysis: ExtensionAnalysis;
}) {
  const issues = analysis.issues;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const errors = issues.filter((issue) => issue.severity === "failed").length;

  return (
    <section className="card card-pad">
      <div className="mb-5">
        <p className="eyebrow">Configuration</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">
          Checks &amp; issues
        </h2>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <IssueSummary label="Passed" count={issues.filter((item) => item.severity === "passed").length} tone="success" />
        <IssueSummary label="Review" count={warnings} tone="warning" />
        <IssueSummary label="Failed" count={errors} tone="error" />
      </div>

      {issues.length === 0 ? (
        <div className="rounded-xl bg-[var(--status-success-soft)] p-4 text-sm text-[var(--text-primary)]">
          No configuration problems found by Phase 1 checks.
        </div>
      ) : (
        <ul className="space-y-3">
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} />
          ))}
        </ul>
      )}
    </section>
  );
}

function IssueSummary({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "success" | "warning" | "error";
}) {
  const color =
    tone === "success"
      ? "text-[var(--status-success)]"
      : tone === "warning"
        ? "text-[var(--status-warning)]"
        : "text-[var(--status-error)]";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1 text-xs font-medium">
      <span className={cnDot(tone)} />
      {label}
      <span className="tabular-nums">{count}</span>
    </span>
  );
}

function cnDot(tone: "success" | "warning" | "error"): string {
  return `inline-block h-2 w-2 rounded-full ${
    tone === "success"
      ? "bg-[var(--status-success)]"
      : tone === "warning"
        ? "bg-[var(--status-warning)]"
        : "bg-[var(--status-error)]"
  }`;
}

function IssueRow({ issue }: { issue: AnalyzerIssue }) {
  return (
    <li className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
      <StatusBadge status={issue.severity} />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{issue.title}</p>
        <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
          {issue.message}
        </p>
      </div>
    </li>
  );
}
