"use client";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

/**
 * Phase 9 regression comparison view: previous package version vs current,
 * per browser — new failures, resolved failures, score differences,
 * browser-specific regressions and new runtime/console/network errors.
 */
export interface RegressionResult {
  previous: { label: string; matrixRunId: string | null; runId: string | null; packageVersion: string | null; createdAt: number };
  current: { label: string; matrixRunId: string | null; runId: string | null; packageVersion: string | null; createdAt: number };
  testSuiteId: string | null;
  browsers: Array<{
    browserId: string;
    displayName: string;
    executed: { previous: boolean; current: boolean };
    previousScore: number | null;
    currentScore: number | null;
    regressions: Array<{ testId: string; testName: string; from: string; to: string; kind: string; note?: string }>;
    improvements: Array<{ testId: string; testName: string; from: string; to: string; kind: string }>;
    newRuntimeErrors: string[];
    newConsoleErrors: string[];
    newNetworkFailures: string[];
  }>;
  aggregate: {
    regressionCount: number;
    improvementCount: number;
    scoreDelta: number | null;
    browserSpecificRegressions: string[];
    insufficientData: boolean;
  };
  summary: string;
}

export function RegressionView({ comparisonId }: { comparisonId: string }) {
  const [result, setResult] = useState<RegressionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/regressions/compare?id=${encodeURIComponent(comparisonId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("not found"))))
      .then((body: { result: RegressionResult }) => setResult(body.result))
      .catch(() => setError("This regression comparison could not be loaded."));
  }, [comparisonId]);

  if (error) return <div className="card card-pad text-sm text-[var(--status-error)]">{error}</div>;
  if (!result) return <div className="card card-pad text-sm text-[var(--text-secondary)]">Loading comparison…</div>;

  return (
    <div className="space-y-6">
      <div className="card card-pad">
        <p className="eyebrow">Regression comparison</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {result.previous.packageVersion ?? result.previous.label} → {result.current.packageVersion ?? result.current.label}
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{result.summary}</p>
        <div className="mt-4 flex flex-wrap gap-6 text-sm">
          <Metric label="New regressions" value={result.aggregate.regressionCount} bad={result.aggregate.regressionCount > 0} />
          <Metric label="Resolved (improvements)" value={result.aggregate.improvementCount} good={result.aggregate.improvementCount > 0} />
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Average score change</p>
            <p className="flex items-center gap-1 font-semibold">
              {result.aggregate.scoreDelta === null ? (
                "—"
              ) : result.aggregate.scoreDelta > 0 ? (
                <>
                  <ArrowUpRight className="h-4 w-4 text-[var(--status-success)]" aria-hidden="true" />+{result.aggregate.scoreDelta}
                </>
              ) : result.aggregate.scoreDelta < 0 ? (
                <>
                  <ArrowDownRight className="h-4 w-4 text-[var(--status-error)]" aria-hidden="true" />
                  {result.aggregate.scoreDelta}
                </>
              ) : (
                <>
                  <Minus className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />0
                </>
              )}
            </p>
          </div>
          {result.aggregate.browserSpecificRegressions.length > 0 ? (
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Browser-specific regressions</p>
              <p className="font-semibold capitalize">{result.aggregate.browserSpecificRegressions.join(", ")}</p>
            </div>
          ) : null}
        </div>
        {result.aggregate.insufficientData ? (
          <p className="mt-3 text-xs text-[var(--status-warning)]">
            Some browsers did not execute on both versions; coverage is incomplete.
          </p>
        ) : null}
      </div>

      {result.browsers.map((browser) => (
        <div key={browser.browserId} className="card card-pad">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">{browser.displayName}</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              Score {browser.previousScore ?? "—"} → {browser.currentScore ?? "—"}
            </p>
          </div>

          {browser.regressions.length > 0 ? (
            <div className="mt-4">
              <p className="text-sm font-semibold text-[var(--status-error)]">New regressions</p>
              <ul className="mt-2 space-y-2">
                {browser.regressions.map((regression, index) => (
                  <li key={index} className="rounded-xl border border-[var(--border)] p-3 text-sm">
                    <span className="font-medium">{regression.testName}</span>
                    <span className="ml-2 uppercase text-xs text-[var(--status-error)]">{regression.from} → {regression.to}</span>
                    {regression.note ? <p className="mt-1 text-xs text-[var(--text-secondary)]">{regression.note}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-4 text-sm text-[var(--text-secondary)]">No new regressions.</p>
          )}

          {browser.improvements.length > 0 ? (
            <div className="mt-4">
              <p className="text-sm font-semibold text-[var(--status-success)]">Resolved failures</p>
              <ul className="mt-2 space-y-2">
                {browser.improvements.map((improvement, index) => (
                  <li key={index} className="rounded-xl border border-[var(--border)] p-3 text-sm">
                    <span className="font-medium">{improvement.testName}</span>
                    <span className="ml-2 uppercase text-xs text-[var(--status-success)]">{improvement.from} → {improvement.to}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {browser.newRuntimeErrors.length > 0 || browser.newConsoleErrors.length > 0 || browser.newNetworkFailures.length > 0 ? (
            <div className="mt-4 space-y-2 text-xs">
              {browser.newRuntimeErrors.length > 0 ? (
                <div>
                  <p className="font-semibold">New runtime errors</p>
                  <ul className="mt-1 list-inside list-disc font-mono text-[var(--text-secondary)]">
                    {browser.newRuntimeErrors.slice(0, 5).map((message, index) => <li key={index}>{message}</li>)}
                  </ul>
                </div>
              ) : null}
              {browser.newConsoleErrors.length > 0 ? (
                <div>
                  <p className="font-semibold">New console errors</p>
                  <ul className="mt-1 list-inside list-disc font-mono text-[var(--text-secondary)]">
                    {browser.newConsoleErrors.slice(0, 5).map((message, index) => <li key={index}>{message}</li>)}
                  </ul>
                </div>
              ) : null}
              {browser.newNetworkFailures.length > 0 ? (
                <div>
                  <p className="font-semibold">New network failures</p>
                  <ul className="mt-1 list-inside list-disc font-mono text-[var(--text-secondary)]">
                    {browser.newNetworkFailures.slice(0, 5).map((message, index) => <li key={index}>{message}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, good = false, bad = false }: { label: string; value: number; good?: boolean; bad?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{label}</p>
      <p className={`font-semibold ${bad ? "text-[var(--status-error)]" : good ? "text-[var(--status-success)]" : ""}`}>{value}</p>
    </div>
  );
}
