"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CircleAlert,
  CircleSlash,
  Clock,
  Copy,
  Download,
  FilePlus2,
  FlaskConical,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { exportTestResults, copySummary } from "@/lib/testing/diagnostics";
import { runHasExecutedTests, runOutcomeLabel } from "@/lib/testing/status-labels";
import type { DiagnosticFinding, TestResult, TestScore } from "@/lib/testing/types";

interface PersistedRun {
  run: {
    runId: string;
    status: string;
    stage?: string | null;
    outcome?: string | null;
    errorCode?: string | null;
    reason?: string | null;
    score: number;
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    skipped: number;
    timeout: number;
    error: number;
    startedAt: number | null;
    completedAt: number | null;
    createdAt: number;
    extensionId: string | null;
    extensionName: string | null;
    extensionVersion: string | null;
  };
  results: TestResult[];
  score: TestScore;
  diagnostics: DiagnosticFinding[];
  artifacts?: Array<{ id: string; type: string; size: number; createdAt: number; expiresAt: number | null }>;
  export: Record<string, unknown>;
}

export function PersistentTestRunView({ runId }: { runId: string }) {
  const router = useRouter();
  const [data, setData] = useState<PersistedRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await fetch(`/api/tests/${runId}`);
    if (!response.ok) {
      setError("Test run not found.");
      setLoading(false);
      return;
    }
    setData((await response.json()) as PersistedRun);
    setLoading(false);
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.results;
    const term = search.toLowerCase();
    return data.results.filter((result) =>
      `${result.name} ${result.description} ${result.errors.join(" ")}`.toLowerCase().includes(term),
    );
  }, [data, search]);

  const createReport = useCallback(async () => {
    if (!data?.run.extensionId) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extensionId: data.run.extensionId, testRunId: data.run.runId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "The report could not be created.");
        return;
      }
      const result = (await response.json()) as { report: { id: string } };
      setCreatedId(result.report.id);
    } finally {
      setCreating(false);
    }
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="card h-40 animate-pulse" />
        <div className="card h-32 animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card className="text-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--status-error-soft)] text-[var(--status-error)]">
          <CircleAlert className="h-7 w-7" aria-hidden="true" />
        </span>
        <h2 className="mt-5 text-2xl font-semibold tracking-tight">Test run unavailable</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{error ?? "Unable to load reports."}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
          Retry
        </Button>
      </Card>
    );
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extensionlab-test-report-${runId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(
      copySummary({
        score: data.score,
        issues: data.diagnostics.filter((d) => d.severity === "high" || d.severity === "critical").map((d) => d.title),
      }),
    );
  };

  const executed = runHasExecutedTests({ status: data.run.status, outcome: data.run.outcome, failed: data.run.failed, error_count: data.run.error, timeout: data.run.timeout, warnings: data.run.warnings });
  const outcomeLabel = runOutcomeLabel({ status: data.run.status, outcome: data.run.outcome, failed: data.run.failed, error_count: data.run.error, timeout: data.run.timeout, warnings: data.run.warnings });
  const screenshots = (data.artifacts ?? []).filter((artifact) => artifact.type === "screenshot");

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="eyebrow">Automated Test Report</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{data.run.extensionName ?? "Automated Test Report"}</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            {executed
              ? `${outcomeLabel} · Score ${data.run.score}/100 · ${data.run.passed} passed · ${data.run.failed + data.run.error} failed · ${data.run.warnings} warning · ${data.run.skipped} skipped`
              : `${outcomeLabel} · no automated tests were executed`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.run.extensionId ? (
            <Button variant="accent" size="sm" loading={creating} onClick={() => void createReport()}>
              <FilePlus2 className="h-4 w-4" aria-hidden="true" />
              {createdId ? "Report ready" : "Create Report"}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={exportJson}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Export JSON
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            <Copy className="h-4 w-4" aria-hidden="true" />
            Copy Summary
          </Button>
        </div>
      </div>

      {createdId ? (
        <div className="flex items-center justify-between rounded-xl border border-[var(--status-success)] bg-[var(--status-success-soft)] p-3 text-sm">
          <span>Report created from this immutable snapshot.</span>
          <Button variant="secondary" size="sm" href={`/dashboard/reports/${createdId}`}>
            Open report
          </Button>
        </div>
      ) : null}

      {!executed ? (
        <div className="rounded-xl border border-[var(--status-warning)] bg-[var(--status-warning-soft)] p-4 text-sm" role="status">
          <p className="font-semibold text-[var(--text-primary)]">
            {data.run.outcome === "CANCELLED" ? "This run was cancelled" : "Infrastructure error — this run has no test results"}
          </p>
          <p className="mt-1 text-[var(--text-secondary)]">
            {data.run.reason ?? "The isolated browser could not be started. Static analysis results are unaffected; retry the automated tests once the sandbox is available."}
          </p>
        </div>
      ) : null}

      <div className="card card-pad grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Passed" value={data.run.passed} tone="success" />
        <Stat label="Failed" value={data.run.failed + data.run.error + data.run.timeout} tone="error" />
        <Stat label="Warnings" value={data.run.warnings} tone="warning" />
        <Stat label="Score" value={executed ? `${data.run.score}/100` : "n/a"} accent />
      </div>

      {screenshots.length > 0 ? (
        <Card>
          <h2 className="text-base font-semibold tracking-tight">Screenshots</h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">Captured inside the isolated browser. Private to your account.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {screenshots.map((artifact) => (
              <a key={artifact.id} href={`/api/artifacts/${artifact.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-[var(--border)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/artifacts/${artifact.id}`} alt="Sandbox screenshot" className="h-40 w-full object-cover" loading="lazy" />
              </a>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="card overflow-hidden">
        <div className="border-b border-[var(--border)] p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
            <input
              aria-label="Search tests"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tests…"
              className="min-h-[44px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] pl-9 pr-3 text-sm"
            />
          </div>
        </div>
        <div className="divide-y divide-[var(--border)]">
          {filtered.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--text-secondary)]">No matching tests.</p>
          ) : null}
          {filtered.map((result) => (
            <div key={result.testId}>
              <button
                type="button"
                onClick={() => setExpanded(expanded === result.testId ? null : result.testId)}
                aria-expanded={expanded === result.testId}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-secondary)]"
              >
                <StatusIcon status={result.status} />
                <span className="min-w-0 flex-1 text-sm font-medium">{result.name}</span>
                <span className="shrink-0 text-xs text-[var(--text-secondary)]">{(result.duration / 1000).toFixed(1)}s</span>
                <span className="shrink-0 text-xs font-semibold">{result.status}</span>
              </button>
              {expanded === result.testId ? (
                <div className="border-t border-[var(--border)] bg-[var(--surface-secondary)] px-4 py-4 text-sm">
                  <p className="text-[var(--text-secondary)]">{result.description}</p>
                  {result.skippedReason ? <p className="mt-2 text-[var(--text-secondary)]">Reason: {result.skippedReason}</p> : null}
                  {result.errors.length > 0 ? (
                    <div className="mt-3 space-y-1">
                      {result.errors.map((error, index) => (
                        <p key={index} className="text-[var(--status-error)]">{error}</p>
                      ))}
                    </div>
                  ) : null}
                  {result.warnings.length > 0 ? (
                    <div className="mt-3 space-y-1">
                      {result.warnings.map((warning, index) => (
                        <p key={index} className="text-[var(--status-warning)]">{warning}</p>
                      ))}
                    </div>
                  ) : null}
                  {result.evidence.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Evidence</p>
                      <ul className="mt-1 space-y-1">
                        {result.evidence.map((evidence) => (
                          <li key={evidence.id} className="text-sm">{evidence.label}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <Card>
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />
          <h2 className="text-base font-semibold tracking-tight">Diagnostics</h2>
        </div>
        {data.diagnostics.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--text-secondary)]">No diagnostic findings.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {data.diagnostics.map((finding) => (
              <div key={finding.id} className="rounded-xl border border-[var(--border)] p-3">
                <p className="text-sm font-medium">{finding.title}</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">{finding.description}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone, accent }: { label: string; value: string | number; tone?: "success" | "error" | "warning"; accent?: boolean }) {
  const color =
    tone === "success"
      ? "text-[var(--status-success)]"
      : tone === "error"
        ? "text-[var(--status-error)]"
        : tone === "warning"
          ? "text-[var(--status-warning)]"
          : accent
            ? "text-[var(--accent)]"
            : "";
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight ${color}`}>{value}</p>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  const className = "h-4 w-4";
  if (status === "passed") return <CircleAlert className={`${className} text-[var(--status-success)]`} aria-hidden="true" />;
  if (status === "failed" || status === "error") return <CircleAlert className={`${className} text-[var(--status-error)]`} aria-hidden="true" />;
  if (status === "warning") return <CircleAlert className={`${className} text-[var(--status-warning)]`} aria-hidden="true" />;
  if (status === "skipped") return <CircleSlash className={`${className} text-[var(--text-secondary)]`} aria-hidden="true" />;
  return <Clock className={`${className} text-[var(--text-secondary)]`} aria-hidden="true" />;
}
