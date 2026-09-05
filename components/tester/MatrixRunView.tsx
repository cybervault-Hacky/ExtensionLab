"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Phase 9 browser-matrix dashboard: live per-browser state, deterministic
 * compatibility comparison, per-test browser matrix, findings, side-by-side
 * screenshots and network/console differences.
 */

interface MatrixExecution {
  browserId: string;
  displayName: string;
  engine: string | null;
  browserVersion: string | null;
  status: string;
  outcome: string | null;
  errorCode: string | null;
  reason: string | null;
  score: number | null;
  passed: number;
  failed: number;
  skipped: number;
  runId: string;
  createdAt: number;
  finishedAt: number | null;
}

interface MatrixView {
  matrixRun: {
    id: string;
    status: string;
    suiteId: string;
    suiteName: string | null;
    browsers: string[];
    compatibilityScore: number | null;
    coverage: number | null;
    reportId: string | null;
    reason: string | null;
    createdAt: number;
    finishedAt: number | null;
  };
  executions: MatrixExecution[];
  comparison: {
    results: Array<{
      browserId: string;
      displayName: string;
      browserVersion: string | null;
      engine: string | null;
      status: string;
      executed: boolean;
      score: number;
      passed: number;
      failed: number;
      skipped: number;
      runtimeErrors: number;
      consoleErrors: number;
      networkFailures: number;
      screenshots: number;
      durationMs: number | null;
    }>;
    tests: Array<{
      testId: string;
      name: string;
      category: string;
      differs: boolean;
      cells: Record<string, { status: string; skippedReason?: string; message?: string }>;
    }>;
    findings: Array<{ type: string; title: string; description: string; browsers: string[]; evidence: string[] }>;
    compatibility: {
      score: number | null;
      coverage: number;
      browsersPassing: string[];
      browsersFailing: string[];
      browsersUnavailable: string[];
      unsupportedTests: number;
      basis: string;
    };
    network: Array<{ url: string; method: string; statuses: Record<string, number | null> }>;
    consoleErrors: Array<{ message: string; browsers: string[]; scope: string }>;
  } | null;
}

interface RunArtifact {
  id: string;
  type: string;
  label: string | null;
}

const TERMINAL = ["completed", "partial", "failed", "cancelled"];

export function MatrixRunView({ matrixRunId }: { matrixRunId: string }) {
  const [view, setView] = useState<MatrixView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screenshotsByBrowser, setScreenshotsByBrowser] = useState<Record<string, RunArtifact[]>>({});
  const [comparing, setComparing] = useState(false);
  const [regressionSummary, setRegressionSummary] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/tests/matrix/${matrixRunId}`, { cache: "no-store" });
    if (response.ok) {
      setView((await response.json()) as MatrixView);
    } else {
      setLoadError("This matrix run could not be loaded.");
    }
  }, [matrixRunId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!view || TERMINAL.includes(view.matrixRun.status)) return;
    const source = new EventSource(`/api/tests/matrix/${matrixRunId}/events/stream`);
    esRef.current = source;
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type: string };
        if (payload.type === "matrix" || payload.type === "done") {
          void refresh();
          if (payload.type === "done") source.close();
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    source.onerror = () => {
      source.close();
      void refresh();
    };
    return () => {
      source.close();
      esRef.current = null;
    };
  }, [matrixRunId, view, refresh]);

  // Load screenshots per browser once the matrix finished.
  useEffect(() => {
    if (!view || !TERMINAL.includes(view.matrixRun.status)) return;
    let active = true;
    (async () => {
      const next: Record<string, RunArtifact[]> = {};
      for (const execution of view.executions) {
        try {
          const response = await fetch(`/api/tests/${execution.runId}/results`, { cache: "no-store" });
          if (!response.ok) continue;
          const body = (await response.json()) as { artifacts?: RunArtifact[] };
          next[execution.browserId] = (body.artifacts ?? []).filter((artifact) => artifact.type === "screenshot");
        } catch {
          // Artifacts are optional evidence.
        }
      }
      if (active) setScreenshotsByBrowser(next);
    })();
    return () => {
      active = false;
    };
  }, [view]);

  const cancel = async () => {
    await fetch(`/api/tests/matrix/${matrixRunId}/cancel`, { method: "POST" });
    void refresh();
  };

  const compareWithBaseline = async () => {
    setComparing(true);
    setRegressionSummary(null);
    try {
      const response = await fetch("/api/regressions/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentMatrixRunId: matrixRunId }),
      });
      if (response.status === 409) {
        setRegressionSummary("No baseline is designated for this extension yet. Finish a matrix run and set it as a baseline first.");
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setRegressionSummary(body?.error?.message ?? "The regression comparison could not be created.");
        return;
      }
      const body = (await response.json()) as { comparisonId: string };
      window.location.href = `/dashboard/tests/regression?comparisonId=${body.comparisonId}`;
    } catch {
      setRegressionSummary("We could not reach the ExtensionLab backend.");
    } finally {
      setComparing(false);
    }
  };

  if (loadError) {
    return <div className="card card-pad text-sm text-[var(--status-error)]">{loadError}</div>;
  }
  if (!view) {
    return <div className="card card-pad text-sm text-[var(--text-secondary)]">Loading matrix run…</div>;
  }

  const browserIds = view.matrixRun.browsers;
  const comparison = view.comparison;
  const active = !TERMINAL.includes(view.matrixRun.status);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="card card-pad flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="eyebrow">Browser matrix</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {view.matrixRun.suiteName ?? view.matrixRun.suiteId}
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Matrix run {view.matrixRun.id} · {browserIds.join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Compatibility</p>
            <p className="text-3xl font-semibold">
              {comparison?.compatibility.score === null || comparison?.compatibility.score === undefined
                ? "—"
                : `${comparison.compatibility.score}`}
              <span className="text-base text-[var(--text-secondary)]">/100</span>
            </p>
            {comparison ? (
              <p className="text-xs text-[var(--text-secondary)]">Coverage {Math.round(comparison.compatibility.coverage * 100)}%</p>
            ) : null}
          </div>
          <MatrixStatusBadge status={view.matrixRun.status} />
          {active ? (
            <Button variant="secondary" onClick={cancel}>
              <Ban className="h-4 w-4" aria-hidden="true" />
              Cancel
            </Button>
          ) : (
            <Button variant="secondary" onClick={compareWithBaseline} disabled={comparing}>
              {comparing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Compare with baseline
            </Button>
          )}
        </div>
      </div>

      {/* Browser cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {view.executions.map((execution) => (
          <div key={execution.browserId} className="card card-pad">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold">{execution.displayName}</p>
                <p className="text-xs text-[var(--text-secondary)]">
                  {execution.engine ?? ""} {execution.browserVersion ? `· ${execution.browserVersion}` : ""}
                </p>
              </div>
              <ExecutionStatusIcon status={execution.status} outcome={execution.outcome} />
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-sm">
              <Stat label="Score" value={execution.score ?? "—"} />
              <Stat label="Pass" value={execution.passed} />
              <Stat label="Fail" value={execution.failed} />
              <Stat label="Skip" value={execution.skipped} />
            </div>
            {execution.status === "running" || execution.status === "queued" ? (
              <p className="mt-3 inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" /> {execution.status}
              </p>
            ) : null}
            {execution.errorCode === "BROWSER_RUNTIME_UNAVAILABLE" || execution.outcome === "INFRASTRUCTURE_ERROR" ? (
              <p className="mt-3 text-xs text-[var(--status-warning)]">
                Infrastructure failure — no extension verdict. {execution.reason ?? ""}
              </p>
            ) : null}
            <p className="mt-3 text-xs">
              <Link href={`/dashboard/tests/${execution.runId}`} className="text-[var(--accent)] hover:underline">
                Open run details
              </Link>
            </p>
          </div>
        ))}
      </div>

      {comparison ? (
        <>
          {/* Per-test comparison table */}
          <div className="card card-pad">
            <h2 className="text-lg font-semibold tracking-tight">Test comparison</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left">
                    <th className="py-2 pr-4 font-medium">Test</th>
                    {browserIds.map((browserId) => (
                      <th key={browserId} className="py-2 pr-4 font-medium capitalize">
                        {browserId}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.tests.map((test) => (
                    <tr key={test.testId} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-2 pr-4">
                        <span className={test.differs ? "font-medium" : ""}>{test.name}</span>
                        {test.differs ? (
                          <span className="ml-2 rounded-full bg-[var(--status-warning-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--status-warning)]">
                            differs
                          </span>
                        ) : null}
                      </td>
                      {browserIds.map((browserId) => (
                        <td key={browserId} className="py-2 pr-4" title={test.cells[browserId]?.skippedReason ?? test.cells[browserId]?.message ?? ""}>
                          <CellStatus status={test.cells[browserId]?.status ?? "not-run"} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Findings */}
          <div className="card card-pad">
            <h2 className="text-lg font-semibold tracking-tight">Compatibility findings</h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{comparison.compatibility.basis}</p>
            {comparison.findings.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">No browser-specific differences detected.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {comparison.findings.map((finding, index) => (
                  <li key={`${finding.type}-${index}`} className="rounded-xl border border-[var(--border)] p-4">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <AlertTriangle className="h-4 w-4 text-[var(--status-warning)]" aria-hidden="true" />
                      {finding.title}
                    </p>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">{finding.description}</p>
                    {finding.evidence.length > 0 ? (
                      <ul className="mt-2 list-inside list-disc text-xs text-[var(--text-secondary)]">
                        {finding.evidence.slice(0, 3).map((evidence, evidenceIndex) => (
                          <li key={evidenceIndex}>{evidence}</li>
                        ))}
                      </ul>
                    ) : null}
                    <span className="mt-2 inline-block rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
                      {finding.type.replace(/_/g, " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Screenshot comparison */}
          <div className="card card-pad">
            <h2 className="text-lg font-semibold tracking-tight">Screenshots</h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Side-by-side captures from each browser. No automated image interpretation.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {browserIds.map((browserId) => (
                <div key={browserId}>
                  <p className="mb-2 text-sm font-medium capitalize">{browserId}</p>
                  {(screenshotsByBrowser[browserId] ?? []).length === 0 ? (
                    <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-xs text-[var(--text-secondary)]">
                      No screenshot captured
                    </div>
                  ) : (
                    (screenshotsByBrowser[browserId] ?? []).slice(0, 1).map((artifact) => (
                      <a
                        key={artifact.id}
                        href={`/api/artifacts/${artifact.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="block overflow-hidden rounded-xl border border-[var(--border)]"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/artifacts/${artifact.id}`} alt={`${browserId} screenshot`} className="h-40 w-full object-cover" loading="lazy" />
                      </a>
                    ))
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Network differences */}
          <div className="card card-pad">
            <h2 className="text-lg font-semibold tracking-tight">Network comparison</h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Redacted summaries (URL, method, status). Sensitive headers, cookies and tokens are never stored.
            </p>
            {comparison.network.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">No comparable network evidence was recorded.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left">
                      <th className="py-2 pr-4 font-medium">Request</th>
                      {browserIds.map((browserId) => (
                        <th key={browserId} className="py-2 pr-4 font-medium capitalize">{browserId}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.network.slice(0, 15).map((entry, index) => (
                      <tr key={index} className="border-b border-[var(--border)] last:border-0">
                        <td className="max-w-xs truncate py-2 pr-4" title={entry.url}>{entry.method} {entry.url}</td>
                        {browserIds.map((browserId) => (
                          <td key={browserId} className="py-2 pr-4">{entry.statuses[browserId] ?? "n/a"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Console differences */}
          <div className="card card-pad">
            <h2 className="text-lg font-semibold tracking-tight">Console errors</h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Grouped by normalized signature. Console errors are diagnostics, never a verdict about intent.
            </p>
            {comparison.consoleErrors.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--text-secondary)]">No console errors were captured.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {comparison.consoleErrors.slice(0, 10).map((group, index) => (
                  <li key={index} className="rounded-xl border border-[var(--border)] p-3 text-sm">
                    <p className="font-mono text-xs">{group.message}</p>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">
                      {group.scope === "common" ? "Common across executed browsers" : `Browser-specific: ${group.browsers.join(", ")}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="card card-pad text-sm text-[var(--text-secondary)]">
          The comparison appears when every browser execution has finished.
        </div>
      )}

      {regressionSummary ? (
        <div role="status" className="rounded-xl border border-[var(--status-warning)] bg-[var(--status-warning-soft)] p-3 text-sm">
          {regressionSummary}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[var(--border)] p-2">
      <p className="text-xs text-[var(--text-secondary)]">{label}</p>
      <p className="font-semibold">{value}</p>
    </div>
  );
}

function MatrixStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    partial: "Partial",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return (
    <span className="rounded-full border border-[var(--border)] px-3 py-1 text-sm font-medium">
      {map[status] ?? status}
    </span>
  );
}

function ExecutionStatusIcon({ status, outcome }: { status: string; outcome: string | null }) {
  if (outcome === "INFRASTRUCTURE_ERROR") {
    return <AlertTriangle className="h-6 w-6 text-[var(--status-warning)]" aria-label="Infrastructure failure" />;
  }
  if (status === "completed" && (outcome === "PASSED" || outcome === "WARNING")) {
    return <CheckCircle2 className="h-6 w-6 text-[var(--status-success)]" aria-label="Passed" />;
  }
  if (status === "completed") {
    return <XCircle className="h-6 w-6 text-[var(--status-error)]" aria-label="Failed" />;
  }
  if (status === "failed") {
    return <XCircle className="h-6 w-6 text-[var(--status-error)]" aria-label="Failed" />;
  }
  if (status === "cancelled") {
    return <Ban className="h-6 w-6 text-[var(--text-secondary)]" aria-label="Cancelled" />;
  }
  if (status === "skipped") {
    return <Ban className="h-6 w-6 text-[var(--status-warning)]" aria-label="Skipped" />;
  }
  return <Loader2 className="h-6 w-6 animate-spin text-[var(--text-secondary)]" aria-label="In progress" />;
}

function CellStatus({ status }: { status: string }) {
  const labels: Record<string, string> = {
    passed: "PASS",
    warning: "WARNING",
    failed: "FAIL",
    error: "ERROR",
    timeout: "TIMEOUT",
    skipped: "SKIPPED",
    "not-run": "—",
    unavailable: "N/A",
  };
  const color =
    status === "passed"
      ? "text-[var(--status-success)]"
      : status === "warning" || status === "skipped" || status === "timeout"
        ? "text-[var(--status-warning)]"
        : status === "failed" || status === "error"
          ? "text-[var(--status-error)]"
          : "text-[var(--text-secondary)]";
  return <span className={`font-semibold ${color}`}>{labels[status] ?? status}</span>;
}
