"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { TestBuilder, useDebounced, type StudioDefinitionDraft } from "./TestBuilder";

/**
 * Test Automation Studio shell (Phase 15): saved-test list with server-side
 * search/filter/pagination, builder entry points, per-test run panel, suites
 * and CI pointers. Everything renders from real API responses — no invented
 * state, no fabricated results.
 */

interface SavedTestItem {
  id: string;
  name: string;
  description: string;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  version: number;
  tags: string[];
  browsers: string[];
  packageId: string;
  updatedAt: number;
}

interface PackageItem {
  id: string;
  name: string | null;
  original_name: string | null;
  version: string | null;
}

interface TemplateItem {
  id: string;
  name: string;
  description: string;
  definition: StudioDefinitionDraft | null;
}

interface Analytics {
  totalRuns: number;
  passed: number;
  failed: number;
  averageDurationMs: number | null;
  lastRunAt: number | null;
  flakySuspect: boolean;
}

const statusTone: Record<SavedTestItem["status"], BadgeTone> = { DRAFT: "neutral", ACTIVE: "success", ARCHIVED: "default" };

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function TestStudio() {
  const [tab, setTab] = useState<"tests" | "suites">("tests");
  const [tests, setTests] = useState<SavedTestItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"" | "DRAFT" | "ACTIVE" | "ARCHIVED">("");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [building, setBuilding] = useState<{
    test?: SavedTestItem;
    definition?: StudioDefinitionDraft;
    loading?: boolean;
  } | null>(null);
  const [running, setRunning] = useState<{ id: string; name: string; version: number; browsers: string[]; result: string | null } | null>(null);
  const [runVariables, setRunVariables] = useState<Record<string, string>>({});
  const [suites, setSuites] = useState<Array<{ id: string; name: string; description: string; failurePolicy: string; tests: number; updatedAt: number }>>([]);
  const [suiteForm, setSuiteForm] = useState<{ name: string; failurePolicy: "stop" | "continue"; testIds: string[] } | null>(null);
  const [suiteError, setSuiteError] = useState<string | null>(null);

  const loadTests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      if (status) params.set("status", status);
      const response = await fetch(`/api/tests/saved?${params.toString()}`);
      const body = (await response.json()) as { tests?: SavedTestItem[]; pagination?: { total: number }; message?: string };
      if (!response.ok) throw new Error(body.message ?? "Loading failed.");
      setTests(body.tests ?? []);
      setTotal(body.pagination?.total ?? 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Loading failed.");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, status]);

  useEffect(() => {
    if (tab === "tests") void loadTests();
  }, [tab, loadTests]);

  useEffect(() => {
    void (async () => {
      const [packagesResponse, templatesResponse] = await Promise.all([fetch("/api/packages"), fetch("/api/tests/templates")]);
      if (packagesResponse.ok) {
        const body = (await packagesResponse.json()) as { items?: PackageItem[] };
        setPackages(body.items ?? []);
      }
      if (templatesResponse.ok) {
        const body = (await templatesResponse.json()) as { templates?: TemplateItem[] };
        setTemplates(body.templates ?? []);
      }
    })();
  }, []);

  const loadSuites = useCallback(async () => {
    const response = await fetch("/api/tests/suites");
    if (response.ok) {
      const body = (await response.json()) as { suites?: typeof suites };
      setSuites(body.suites ?? []);
    }
  }, []);

  useEffect(() => {
    if (tab === "suites") void loadSuites();
  }, [tab, loadSuites]);

  const startRun = async () => {
    if (!running || running.result) return;
    try {
      const response = await fetch(`/api/tests/saved/${running.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: running.version,
          browser: undefined,
          variables: Object.keys(runVariables).length > 0 ? runVariables : undefined,
        }),
      });
      const body = (await response.json()) as { runId?: string; message?: string; error?: string };
      if (!response.ok) throw new Error(body.message ?? body.error ?? "The run could not be queued.");
      setRunning({ ...running, result: `Queued as run ${body.runId}. Open Recent Runs to watch it execute.` });
    } catch (cause) {
      setRunning({ ...running, result: cause instanceof Error ? cause.message : "The run could not be queued." });
    }
  };

  if (building) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">{building.test ? `Edit: ${building.test.name}` : "New test"}</h2>
          <Button variant="ghost" onClick={() => setBuilding(null)}>
            Back to list
          </Button>
        </div>
        {building.loading ? (
          <p className="text-sm text-[var(--text-secondary)]">Loading definition…</p>
        ) : (
        <TestBuilder
          initial={
            building.test && building.definition
              ? {
                  id: building.test.id,
                  name: building.test.name,
                  description: building.test.description,
                  tags: building.test.tags,
                  browsers: building.test.browsers,
                  definition: building.definition,
                  status: building.test.status,
                  version: building.test.version,
                }
              : undefined
          }
          packages={packages.map((pkg) => ({ id: pkg.id, name: pkg.original_name ?? pkg.name ?? "package", version: pkg.version }))}
          templates={templates.map((template) => ({ id: template.id, name: template.name, description: template.description, definition: template.definition }))}
          onSaved={() => setBuilding(null)}
          onCancel={() => setBuilding(null)}
        />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Studio sections" className="flex gap-2">
        <Button variant={tab === "tests" ? "primary" : "ghost"} size="sm" onClick={() => setTab("tests")} aria-pressed={tab === "tests"}>
          Tests
        </Button>
        <Button variant={tab === "suites" ? "primary" : "ghost"} size="sm" onClick={() => setTab("suites")} aria-pressed={tab === "suites"}>
          Suites
        </Button>
      </div>

      {tab === "tests" && (
        <>
          <Card className="flex flex-wrap items-end gap-3">
            <div className="grow">
              <label className="text-sm" htmlFor="studio-search">
                Search tests
              </label>
              <input
                id="studio-search"
                className="min-h-[44px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)]"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Name or description"
              />
            </div>
            <div>
              <label className="text-sm" htmlFor="studio-status">
                Status
              </label>
              <select
                id="studio-status"
                className="min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as "" | "DRAFT" | "ACTIVE" | "ARCHIVED");
                  setPage(1);
                }}
              >
                <option value="">All</option>
                <option value="DRAFT">Draft</option>
                <option value="ACTIVE">Active</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </div>
            <Button onClick={() => setBuilding({})} disabled={packages.length === 0}>
              New test
            </Button>
          </Card>
          {packages.length === 0 && (
            <p className="text-sm text-[var(--text-secondary)]">Upload an extension package first — saved tests bind to the exact package bytes they were authored against.</p>
          )}
          {error && (
            <p role="alert" className="text-sm text-[var(--status-error)]">
              {error}
            </p>
          )}
          {loading ? (
            <p className="text-sm text-[var(--text-secondary)]">Loading…</p>
          ) : tests.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--text-secondary)]">No saved tests yet. Create one, or start from a built-in template in the builder.</p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {tests.map((test) => (
                <li key={test.id}>
                  <Card className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/dashboard/tests/studio/${test.id}`} className="font-medium hover:underline focus-visible:outline-2">
                          {test.name}
                        </Link>
                        <Badge tone={statusTone[test.status]}>{test.status}</Badge>
                        <Badge>v{test.version}</Badge>
                        {test.browsers.map((browser) => (
                          <Badge key={browser} tone="info">
                            {browser}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">
                        {test.description || "No description."} · updated {formatTime(test.updatedAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => setRunning({ id: test.id, name: test.name, version: test.version, browsers: test.browsers, result: null })}>
                        Run
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void (async () => {
                            setBuilding({ test, loading: true });
                            const response = await fetch(`/api/tests/saved/${test.id}`);
                            const body = (await response.json()) as { definition?: StudioDefinitionDraft; message?: string };
                            setBuilding(
                              response.ok && body.definition
                                ? { test, definition: body.definition }
                                : { test, loading: false, definition: undefined },
                            );
                            if (!response.ok) setError(body.message ?? "Could not load the test definition.");
                          })()
                        }
                      >
                        Edit
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>
              Previous
            </Button>
            <span className="text-xs text-[var(--text-secondary)]">
              Page {page} of {Math.max(1, Math.ceil(total / 20))} ({total} tests)
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPage((current) => current + 1)} disabled={page >= Math.ceil(total / 20)}>
              Next
            </Button>
          </div>

          {running && (
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold">Run “{running.name}” (v{running.version})</h3>
              <p className="text-xs text-[var(--text-secondary)]">
                The run executes in a fresh isolated browser against the exact package this test was saved for. Results appear in{" "}
                <Link href="/dashboard/tests" className="underline">
                  Recent Runs
                </Link>{" "}
                and on the test page.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="text-xs" htmlFor="run-variable-name">
                    Variable name
                  </label>
                  <input
                    id="run-variable-name"
                    className="min-h-[36px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-2 text-xs"
                    placeholder="e.g. search_term"
                    onChange={(event) => event.target.dataset.name = event.target.value}
                  />
                </div>
                <div>
                  <label className="text-xs" htmlFor="run-variable-value">
                    Value
                  </label>
                  <input id="run-variable-value" className="min-h-[36px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-2 text-xs" />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const nameInput = document.getElementById("run-variable-name") as HTMLInputElement | null;
                    const valueInput = document.getElementById("run-variable-value") as HTMLInputElement | null;
                    if (nameInput?.dataset.name && valueInput) setRunVariables((current) => ({ ...current, [nameInput.dataset.name!]: valueInput.value }));
                  }}
                >
                  Set variable
                </Button>
                <Button size="sm" onClick={() => void startRun()} disabled={running.result !== null}>
                  Queue run
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRunning(null)}>
                  Close
                </Button>
              </div>
              {Object.keys(runVariables).length > 0 && (
                <p className="text-xs text-[var(--text-secondary)]">Variables: {Object.entries(runVariables).map(([name, value]) => `${name}=${value.slice(0, 40)}`).join(", ")}</p>
              )}
              {running.result && <p className="text-sm">{running.result}</p>}
            </Card>
          )}
        </>
      )}

      {tab === "suites" && (
        <>
          <Card className="flex items-center justify-between">
            <p className="text-sm text-[var(--text-secondary)]">Suites run several saved tests in one fresh browser with deterministic order, explicit dependencies and a failure policy.</p>
            <Button size="sm" onClick={() => setSuiteForm({ name: "", failurePolicy: "stop", testIds: [] })}>
              New suite
            </Button>
          </Card>
          {suites.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--text-secondary)]">No suites yet.</p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {suites.map((suite) => (
                <li key={suite.id}>
                  <Card className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="font-medium">{suite.name}</span>
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">
                        {suite.tests} test(s) · failure policy: {suite.failurePolicy} · updated {formatTime(suite.updatedAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() =>
                        void (async () => {
                          const response = await fetch(`/api/tests/suites/${suite.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
                          const body = (await response.json()) as { runId?: string; message?: string };
                          setSuiteError(response.ok ? `Suite queued as run ${body.runId}.` : (body.message ?? "Suite run failed."));
                        })()
                      }
                    >
                      Run suite
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          {suiteError && <p role="status" className="text-sm">{suiteError}</p>}
          {suiteForm && (
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold">New suite</h3>
              <div>
                <label className="text-sm" htmlFor="suite-name">
                  Name
                </label>
                <input
                  id="suite-name"
                  className="min-h-[44px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
                  value={suiteForm.name}
                  onChange={(event) => setSuiteForm({ ...suiteForm, name: event.target.value })}
                />
              </div>
              <div>
                <label className="text-sm" htmlFor="suite-policy">
                  Failure policy
                </label>
                <select
                  id="suite-policy"
                  className="min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
                  value={suiteForm.failurePolicy}
                  onChange={(event) => setSuiteForm({ ...suiteForm, failurePolicy: event.target.value as "stop" | "continue" })}
                >
                  <option value="stop">Stop on first failure (later tests are skipped, recorded)</option>
                  <option value="continue">Continue after failures</option>
                </select>
              </div>
              <fieldset>
                <legend className="text-sm">Members (order = execution order)</legend>
                <div className="mt-2 space-y-1">
                  {tests.filter((test) => test.status !== "ARCHIVED").length === 0 ? (
                    <p className="text-xs text-[var(--text-secondary)]">No active saved tests available. Suite members must share the same package version.</p>
                  ) : (
                    tests
                      .filter((test) => test.status !== "ARCHIVED")
                      .map((test) => (
                        <label key={test.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={suiteForm.testIds.includes(test.id)}
                            onChange={(event) =>
                              setSuiteForm({
                                ...suiteForm,
                                testIds: event.target.checked ? [...suiteForm.testIds, test.id] : suiteForm.testIds.filter((id) => id !== test.id),
                              })
                            }
                          />
                          {test.name} (v{test.version})
                        </label>
                      ))
                  )}
                </div>
              </fieldset>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={suiteForm.name.trim() === "" || suiteForm.testIds.length === 0}
                  onClick={() =>
                    void (async () => {
                      const response = await fetch("/api/tests/suites", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ name: suiteForm.name, failurePolicy: suiteForm.failurePolicy, testIds: suiteForm.testIds }),
                      });
                      const body = (await response.json()) as { suite?: { id: string }; message?: string };
                      if (!response.ok) {
                        setSuiteError(body.message ?? "Suite creation failed.");
                        return;
                      }
                      setSuiteForm(null);
                      setSuiteError(null);
                      await loadSuites();
                    })()
                  }
                >
                  Create suite
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSuiteForm(null)}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export type { Analytics };
