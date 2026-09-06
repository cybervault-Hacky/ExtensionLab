"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

/**
 * Saved-test detail (Phase 15): definition summary, versions, analytics,
 * baseline state + save/compare, recent runs and CI usage hints. Every number
 * shown is computed server-side from real runs.
 */

interface DetailResponse {
  test: {
    id: string;
    name: string;
    description: string;
    status: "DRAFT" | "ACTIVE" | "ARCHIVED";
    version: number;
    tags: string[];
    browsers: string[];
    packageId: string;
    packageVersion: string | null;
    createdAt: number;
    updatedAt: number;
  };
  definition: {
    setup: Array<{ type: string; selector?: string; value?: string; url?: string }>;
    actions: Array<{ type: string; selector?: string; value?: string; url?: string; milliseconds?: number }>;
    assertions: Array<{ type: string; selector?: string; value?: string }>;
    cleanup: Array<{ type: string }>;
    variables: Array<{ name: string; type: string; required?: boolean }>;
    timeoutMs: number;
  };
  versions: Array<{ version: number; createdAt: number }>;
  analytics: {
    totalRuns: number;
    passed: number;
    failed: number;
    timeout: number;
    error: number;
    averageDurationMs: number | null;
    lastRunAt: number | null;
    lastFailureAt: number | null;
    flakySuspect: boolean;
  };
}

interface RunRow {
  id: string;
  status: string;
  outcome: string | null;
  created_at: number;
  passed: number;
  failed: number;
  total: number;
  saved_test_version: number | null;
}

const outcomeTone: Record<string, BadgeTone> = {
  PASSED: "success",
  FAILED: "error",
  TIMEOUT: "warning",
  CANCELLED: "neutral",
  INFRASTRUCTURE_ERROR: "warning",
};

function formatTime(timestamp: number | null): string {
  return timestamp === null ? "never" : new Date(timestamp).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function SavedTestDetail({ testId }: { testId: string }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<{ runId: string; version: number; outcome: string; createdAt: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [detailResponse, runsResponse, baselineResponse] = await Promise.all([
        fetch(`/api/tests/saved/${testId}`),
        fetch(`/api/tests/saved/${testId}/runs`),
        fetch(`/api/tests/saved/${testId}/baseline`),
      ]);
      const detailBody = (await detailResponse.json()) as DetailResponse & { message?: string };
      if (!detailResponse.ok) throw new Error(detailBody.message ?? "Test not found.");
      setDetail(detailBody);
      if (runsResponse.ok) {
        const body = (await runsResponse.json()) as { runs?: RunRow[] };
        setRuns(body.runs ?? []);
      }
      if (baselineResponse.ok) {
        const body = (await baselineResponse.json()) as { baseline: { runId: string; version: number; outcome: string; createdAt: number } | null };
        setBaseline(body.baseline);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Loading failed.");
    }
  }, [testId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveBaseline = async (runId: string) => {
    const response = await fetch(`/api/tests/saved/${testId}/baseline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    const body = (await response.json()) as { baseline?: typeof baseline; message?: string };
    setNotice(response.ok ? `Baseline saved from run ${runId}.` : (body.message ?? "Could not save the baseline."));
    if (response.ok && body.baseline) setBaseline(body.baseline);
  };

  const compare = async (runId: string) => {
    const response = await fetch(`/api/tests/saved/${testId}/baseline?runId=${encodeURIComponent(runId)}`);
    const body = (await response.json()) as { comparison?: { classification: string; findings: string[] }; message?: string };
    if (!response.ok || !body.comparison) {
      setNotice(body.message ?? "Could not compare.");
      return;
    }
    setNotice(`Comparison vs baseline: ${body.comparison.classification}. ${body.comparison.findings.join(" ")}`);
  };

  if (error) {
    return (
      <div>
        <p role="alert" className="text-sm text-[var(--status-error)]">
          {error}
        </p>
        <Link href="/dashboard/tests/studio" className="text-sm underline">
          Back to the studio
        </Link>
      </div>
    );
  }
  if (!detail) return <p className="text-sm text-[var(--text-secondary)]">Loading…</p>;

  const { test, definition, analytics } = detail;
  const passRate = analytics.totalRuns > 0 ? Math.round((analytics.passed / analytics.totalRuns) * 100) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Saved test</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{test.name}</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{test.description || "No description."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={test.status === "ACTIVE" ? "success" : "neutral"}>{test.status}</Badge>
          <Badge>v{test.version}</Badge>
          {test.browsers.map((browser) => (
            <Badge key={browser} tone="info">
              {browser}
            </Badge>
          ))}
          {analytics.flakySuspect && <Badge tone="warning">Flaky suspect (deterministic)</Badge>}
        </div>
      </div>

      <Card className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs text-[var(--text-secondary)]">Runs recorded</p>
          <p className="text-lg font-semibold">{analytics.totalRuns}</p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-secondary)]">Pass rate</p>
          <p className="text-lg font-semibold">{passRate === null ? "No runs yet" : `${passRate}% (${analytics.passed}/${analytics.totalRuns})`}</p>
          {analytics.totalRuns > 0 && analytics.totalRuns < 5 && (
            <p className="text-xs text-[var(--text-secondary)]">Small sample — treat this rate cautiously.</p>
          )}
        </div>
        <div>
          <p className="text-xs text-[var(--text-secondary)]">Average duration</p>
          <p className="text-lg font-semibold">{analytics.averageDurationMs === null ? "—" : `${(analytics.averageDurationMs / 1000).toFixed(1)}s`}</p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-secondary)]">Last failure</p>
          <p className="text-lg font-semibold">{formatTime(analytics.lastFailureAt)}</p>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-sm font-semibold">Definition (v{test.version})</h2>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Setup:</dt>
              <dd>{definition.setup.length} step(s)</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Actions:</dt>
              <dd>
                <ol className="list-decimal ml-4">
                  {definition.actions.map((action, index) => (
                    <li key={index}>
                      {action.type}
                      {action.selector ? ` ${action.selector}` : ""}
                      {action.url ? ` → ${action.url}` : ""}
                      {action.value ? ` “${action.value.slice(0, 40)}”` : ""}
                      {action.milliseconds !== undefined ? ` ${action.milliseconds}ms` : ""}
                    </li>
                  ))}
                </ol>
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Assertions:</dt>
              <dd>
                <ul className="list-disc ml-4">
                  {definition.assertions.map((assertion, index) => (
                    <li key={index}>
                      {assertion.type}
                      {assertion.selector ? ` ${assertion.selector}` : ""}
                      {assertion.value ? ` “${assertion.value.slice(0, 40)}”` : ""}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Cleanup:</dt>
              <dd>{definition.cleanup.length} step(s)</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Variables:</dt>
              <dd>
                {definition.variables.length === 0
                  ? "none"
                  : definition.variables.map((variable) => `${variable.name} (${variable.type}${variable.required ? ", required" : ""})`).join(", ")}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Timeout:</dt>
              <dd>{(definition.timeoutMs / 1000).toFixed(1)}s</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Package:</dt>
              <dd>
                {test.packageId.slice(0, 16)}… {test.packageVersion ? `(v${test.packageVersion})` : ""}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            Editing the definition creates v{test.version + 1}; past runs stay bound to the version they executed.
          </p>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold">Version history</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.versions.map((version) => (
              <li key={version.version} className="flex items-center gap-2">
                <Badge tone={version.version === test.version ? "accent" : "neutral"}>v{version.version}</Badge>
                <span className="text-xs text-[var(--text-secondary)]">{formatTime(version.createdAt)}</span>
              </li>
            ))}
          </ul>
          {baseline && (
            <div className="mt-4 border-t border-[var(--border)] pt-3">
              <h3 className="text-sm font-semibold">Baseline</h3>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Run {baseline.runId.slice(0, 14)}… · v{baseline.version} · {baseline.outcome} · saved {formatTime(baseline.createdAt)}
              </p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Comparisons classify deterministically (NEW_FAILURE / FIXED_FAILURE / UNCHANGED_FAILURE / NEW_WARNING / PERFORMANCE_REGRESSION /
                NO_REGRESSION). Screenshot diffing is not implemented — screenshots are kept as evidence only.
              </p>
            </div>
          )}
          {notice && (
            <p role="status" className="mt-3 text-sm">
              {notice}
            </p>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent runs</h2>
          <Link href="/dashboard/tests" className="text-xs underline">
            All runs
          </Link>
        </div>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--text-secondary)]">No runs yet.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <caption className="sr-only">Recent runs of this saved test</caption>
            <thead>
              <tr className="text-left text-xs text-[var(--text-secondary)]">
                <th scope="col">Run</th>
                <th scope="col">Version</th>
                <th scope="col">Outcome</th>
                <th scope="col">Passed</th>
                <th scope="col">When</th>
                <th scope="col">Baseline</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-[var(--border)]">
                  <td>
                    <Link href={`/dashboard/tests/${run.id}`} className="underline focus-visible:outline-2">
                      {run.id.slice(0, 14)}…
                    </Link>
                  </td>
                  <td>v{run.saved_test_version ?? "?"}</td>
                  <td>
                    <Badge tone={outcomeTone[run.outcome ?? ""] ?? "neutral"}>{run.outcome ?? run.status}</Badge>
                  </td>
                  <td>
                    {run.passed}/{run.total}
                  </td>
                  <td className="text-xs text-[var(--text-secondary)]">{formatTime(run.created_at)}</td>
                  <td>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void saveBaseline(run.id)}>
                        Set baseline
                      </Button>
                      {baseline && (
                        <Button size="sm" variant="ghost" onClick={() => void compare(run.id)}>
                          Compare
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Run from CI</h2>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Use an existing API key with the tests:write scope (organization keys; plan limits apply — API keys never bypass them):
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 text-xs">
{`curl -X POST "$EXTENSIONLAB_URL/api/v1/tests/${test.id}/runs" \\
  -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \\
  -H "Idempotency-Key: build-$GITHUB_RUN_ID" \\
  -H "Content-Type: application/json" \\
  -d '{"browser":"chromium"}'

# poll until status is terminal (COMPLETED / FAILED / TIMEOUT / CANCELLED)
curl "$EXTENSIONLAB_URL/api/v1/tests/${test.id}/runs/<runId>" \\
  -H "Authorization: Bearer $EXTENSIONLAB_API_KEY"`}
        </pre>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          exitCode is 0 only when the run completed successfully. See docs/CI_CD.md for GitHub Actions, GitLab, CircleCI and Jenkins examples with
          placeholder values (never real keys).
        </p>
      </Card>
    </div>
  );
}
