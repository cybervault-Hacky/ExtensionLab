"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  CircleSlash,
  Clock,
  FlaskConical,
  Loader2,
  Search,
  Square,
  Download,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { exportTestResults, copySummary } from "@/lib/testing/diagnostics";
import { summarizeResults } from "@/lib/testing/results";
import type {
  DiagnosticFinding,
  TestResult,
  TestRunInfo,
  TestScore,
} from "@/lib/testing/types";

type FilterKey = "all" | "passed" | "failed" | "warnings" | "skipped";
type CategoryFilterKey = "all" | "runtime" | "network" | "console" | "extension" | "security";

const statusIcon: Record<string, typeof CheckCircle2> = {
  passed: CheckCircle2,
  failed: CircleAlert,
  warning: CircleAlert,
  skipped: CircleSlash,
  timeout: Clock,
  error: CircleAlert,
  pending: Clock,
  running: Loader2,
};

function statusColor(status: string): string {
  if (status === "passed") return "text-[var(--status-success)]";
  if (status === "failed" || status === "error") return "text-[var(--status-error)]";
  if (status === "warning") return "text-[var(--status-warning)]";
  return "text-[var(--text-secondary)]";
}

export function AutomatedTestRunView({ runId }: { runId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<TestRunInfo | null>(null);
  const [results, setResults] = useState<TestResult[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticFinding[]>([]);
  const [score, setScore] = useState<TestScore | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [category, setCategory] = useState<CategoryFilterKey>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const seenEvent = useRef(new Set<string>());

  useEffect(() => {
    const stored = window.sessionStorage.getItem(`extensionlab:test-token:${runId}`);
    setToken(stored);
    if (!stored) setFatal("Automated test run not found. Launch automated tests from the analysis report first.");
  }, [runId]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const headers = { "x-sandbox-token": token };
    const statusResponse = await fetch(`/api/tests/${runId}/status`, { headers });
    if (!statusResponse.ok) {
      const body = (await statusResponse.json().catch(() => null)) as { error?: { message?: string } } | null;
      setFatal(body?.error?.message ?? "Automated test run was not found.");
      return;
    }
    setInfo((await statusResponse.json()) as TestRunInfo);

    const resultsResponse = await fetch(`/api/tests/${runId}/results`, { headers });
    if (resultsResponse.ok) {
      const data = (await resultsResponse.json()) as { results: TestResult[]; score: TestScore; diagnostics: DiagnosticFinding[] };
      setResults(data.results);
      setScore(data.score);
      setDiagnostics(data.diagnostics);
    }
  }, [runId, token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const timer = setInterval(refresh, 900);
    return () => clearInterval(timer);
  }, [token, refresh]);

  useEffect(() => {
    if (!token) return;
    let buffer = "";
    const controller = new AbortController();
    const run = async () => {
      const response = await fetch(`/api/tests/${runId}/events/stream`, {
        headers: { "x-sandbox-token": token },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const line = block.split("\n").find((part) => part.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!seenEvent.current.has(payload)) {
            seenEvent.current.add(payload);
            setEvents((current) => [...current, payload].slice(-200));
          }
        }
      }
    };
    void run().catch(() => undefined);
    return () => controller.abort();
  }, [runId, token]);

  const stopTests = useCallback(async () => {
    if (!token) return;
    await fetch(`/api/tests/${runId}/stop`, {
      method: "POST",
      headers: { "x-sandbox-token": token },
    }).catch(() => undefined);
  }, [runId, token]);

  const visibleResults = useMemo(() => {
    return results.filter((result) => {
      if (filter === "passed" && result.status !== "passed") return false;
      if (filter === "failed" && result.status !== "failed" && result.status !== "error" && result.status !== "timeout") return false;
      if (filter === "warnings" && result.status !== "warning") return false;
      if (filter === "skipped" && result.status !== "skipped") return false;
      if (category === "runtime" && !["page", "popup", "storage", "loading"].includes(result.category)) return false;
      if (category === "network" && result.category !== "network") return false;
      if (category === "console" && result.category !== "console") return false;
      if (category === "extension" && !["content_script", "service_worker", "background", "loading"].includes(result.category)) return false;
      if (category === "security" && !["permissions", "manifest", "security"].includes(result.category)) return false;
      if (search.trim() && !`${result.name} ${result.description} ${result.errors.join(" ")}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [results, filter, category, search]);

  const exportJson = useCallback(() => {
    if (!info || !score) return;
    const payload = exportTestResults({
      runId,
      results,
      diagnostics,
      score,
      timestamps: { createdAt: info.createdAt, startedAt: info.startedAt, finishedAt: info.finishedAt },
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extensionlab-test-report-${runId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [info, score, results, diagnostics, runId]);

  const copy = useCallback(async () => {
    if (!info || !score) return;
    const text = copySummary({
      score,
      issues: diagnostics.filter((finding) => finding.severity === "high" || finding.severity === "critical").map((finding) => finding.title),
    });
    await navigator.clipboard.writeText(text);
  }, [info, score, diagnostics]);

  const liveTests = useMemo(() => {
    if (!info) return [];
    return results.length > 0 ? results : [];
  }, [info, results]);

  if (fatal) {
    return (
      <div className="card card-pad mx-auto max-w-xl text-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--status-error-soft)] text-[var(--status-error)]">
          <CircleAlert className="h-7 w-7" aria-hidden="true" />
        </span>
        <h2 className="mt-5 text-2xl font-semibold tracking-tight">Automated test run unavailable</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{fatal}</p>
        <a href="/dashboard" className="mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent)] px-5 text-sm font-medium text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Analysis
        </a>
      </div>
    );
  }

  const finished = info?.state === "completed" || info?.state === "timeout" || info?.state === "destroyed" || info?.state === "failed";
  const summary = summarizeResults(results);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <FlaskConical className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Automated Testing</h1>
            <p className="text-sm text-[var(--text-secondary)]">{stateLabel(info?.state)}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={exportJson} disabled={!finished}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Export JSON
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void copy()} disabled={!finished}>
            <Copy className="h-4 w-4" aria-hidden="true" />
            Copy Summary
          </Button>
          <Button variant="accent" size="sm" onClick={() => void stopTests()} disabled={finished}>
            <Square className="h-4 w-4" aria-hidden="true" />
            Stop Tests
          </Button>
        </div>
      </div>

      <div className="card card-pad grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Tests" value={String(info?.total ?? summary.total)} />
        <Stat label="Passed" value={String(summary.passed)} tone="success" />
        <Stat label="Failed" value={String(summary.failed + summary.error + summary.timeout)} tone="error" />
        <Stat label="Score" value={info ? `${info.score}/100` : "—"} accent />
      </div>

      {summary.skipped > 0 ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <CircleSlash className="h-4 w-4" aria-hidden="true" />
          {summary.skipped} test(s) were skipped because they are not applicable to this extension.
        </div>
      ) : null}

      <div className="card overflow-hidden">
        <div className="border-b border-[var(--border)] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {(["all", "passed", "failed", "warnings", "skipped"] as FilterKey[]).map((key) => (
                <FilterButton key={key} active={filter === key} label={key === "warnings" ? "Warnings" : key.charAt(0).toUpperCase() + key.slice(1)} onClick={() => setFilter(key)} />
              ))}
            </div>
            <div className="flex items-center gap-3">
              <select
                aria-label="Filter by category"
                value={category}
                onChange={(event) => setCategory(event.target.value as CategoryFilterKey)}
                className="min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
              >
                <option value="all">All categories</option>
                <option value="runtime">Runtime</option>
                <option value="network">Network</option>
                <option value="console">Console</option>
                <option value="extension">Extension</option>
                <option value="security">Security</option>
              </select>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
                <input
                  aria-label="Search tests"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tests..."
                  className="min-h-[44px] w-full min-w-[180px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] pl-9 pr-3 text-sm"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="divide-y divide-[var(--border)]">
          {visibleResults.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--text-secondary)]">No matching tests yet.</p>
          ) : null}
          {visibleResults.map((result) => {
            const Icon = statusIcon[result.status] ?? Clock;
            return (
              <div key={result.testId}>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === result.testId ? null : result.testId)}
                  aria-expanded={expanded === result.testId}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-secondary)]"
                >
                  <Icon className={cn("h-4 w-4", statusColor(result.status), result.status === "running" && "animate-spin")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-sm font-medium">{result.name}</span>
                  <span className="shrink-0 text-xs text-[var(--text-secondary)]">{(result.duration / 1000).toFixed(1)}s</span>
                  <span className={cn("shrink-0 text-xs font-semibold", statusColor(result.status))}>{statusLabel(result.status)}</span>
                </button>
                {expanded === result.testId ? (
                  <div className="border-t border-[var(--border)] bg-[var(--surface-secondary)] px-4 py-4 text-sm">
                    <p className="text-[var(--text-secondary)]">{result.description}</p>
                    {result.skippedReason ? (
                      <p className="mt-2 text-[var(--text-secondary)]">Reason: {result.skippedReason}</p>
                    ) : null}
                    {result.steps.length > 0 ? (
                      <div className="mt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Steps</p>
                        <ul className="mt-1 space-y-1">
                          {result.steps.map((step, index) => (
                            <li key={`${result.testId}-${index}`} className="text-sm text-[var(--text-primary)]">{index + 1}. {step}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {result.assertions.length > 0 ? (
                      <div className="mt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Assertions</p>
                        <ul className="mt-1 space-y-1">
                          {result.assertions.map((assertion, index) => (
                            <li key={`${result.testId}-assert-${index}`} className={cn("text-sm", assertion.passed ? "text-[var(--status-success)]" : "text-[var(--status-error)]")}>
                              {assertion.passed ? "✓ " : "✕ "}{assertion.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {result.errors.length > 0 ? (
                      <div className="mt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Errors</p>
                        <ul className="mt-1 space-y-1 text-sm text-[var(--status-error)]">
                          {result.errors.map((error, index) => <li key={index}>{error}</li>)}
                        </ul>
                      </div>
                    ) : null}
                    {result.evidence.length > 0 ? (
                      <div className="mt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Evidence</p>
                        <ul className="mt-1 space-y-1 text-sm text-[var(--text-primary)]">
                          {result.evidence.map((evidence, index) => (
                            <li key={`${result.testId}-ev-${index}`}>{evidence.label}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {diagnostics.length > 0 ? (
        <div className="card card-pad">
          <h2 className="text-lg font-semibold tracking-tight">Runtime Diagnostics</h2>
          <div className="mt-4 space-y-3">
            {diagnostics.map((finding) => (
              <div key={finding.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-4">
                <div className="flex items-center gap-2">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", severityClass(finding.severity))}>{finding.severity}</span>
                  <span className="text-sm font-semibold">{finding.title}</span>
                </div>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">{finding.description}</p>
                {finding.recommendation ? <p className="mt-2 text-sm text-[var(--text-primary)]">Recommendation: {finding.recommendation}</p> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone, accent }: { label: string; value: string; tone?: "success" | "error"; accent?: boolean }) {
  const color = tone === "success" ? "text-[var(--status-success)]" : tone === "error" ? "text-[var(--status-error)]" : accent ? "text-[var(--accent)]" : "text-[var(--text-primary)]";
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tracking-tight", color)}>{value}</p>
    </div>
  );
}

function FilterButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-h-[40px] rounded-full px-4 text-sm font-medium transition-colors",
        active ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
      )}
    >
      {label}
    </button>
  );
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { pending: "Pending", running: "Running", passed: "PASSED", failed: "FAILED", warning: "WARNING", skipped: "SKIPPED", timeout: "TIMEOUT", error: "ERROR" };
  return labels[status] ?? status.toUpperCase();
}

function stateLabel(state?: string): string {
  const labels: Record<string, string> = {
    idle: "Preparing...",
    preparing: "Preparing automated test suite...",
    starting: "Creating sandbox and starting Chromium...",
    running: "Running tests...",
    completed: "Completed",
    failed: "Failed",
    timeout: "Timed out",
    stopping: "Stopping tests...",
    destroyed: "Destroyed",
  };
  return state ? labels[state] ?? state : "Preparing...";
}

function severityClass(severity: string): string {
  if (severity === "critical" || severity === "high") return "bg-[var(--status-error-soft)] text-[var(--status-error)]";
  if (severity === "medium") return "bg-[var(--status-warning-soft)] text-[var(--status-warning)]";
  return "bg-[var(--accent-soft)] text-[var(--accent)]";
}
