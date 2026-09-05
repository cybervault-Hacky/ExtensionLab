"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { isActiveRunStatus, runOutcomeLabel, runOutcomeTone, runScoreLabel } from "@/lib/testing/status-labels";

type FilterKey = "all" | "passed" | "failed" | "warnings" | "running" | "cancelled";

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "passed", label: "Passed" },
  { key: "failed", label: "Failed" },
  { key: "warnings", label: "Warnings" },
  { key: "running", label: "Running" },
  { key: "cancelled", label: "Cancelled" },
];

interface RunItem {
  id: string;
  status: string;
  outcome?: string | null;
  error_code?: string | null;
  stage?: string | null;
  score: number;
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  created_at: number;
  extensionName: string | null;
  extensionVersion: string | null;
  browserId?: string | null;
  browserVersion?: string | null;
  matrixRunId?: string | null;
}

function browserLabel(browserId: string | null | undefined): string {
  if (!browserId) return "Chromium";
  return browserId.charAt(0).toUpperCase() + browserId.slice(1);
}

export function TestsList() {
  const [items, setItems] = useState<RunItem[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [browser, setBrowser] = useState<"" | "chromium" | "edge" | "firefox">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: "1", limit: "50", status: filter });
    if (search.trim()) params.set("q", search.trim());
    if (browser) params.set("browser", browser);
    const response = await fetch(`/api/tests?${params.toString()}`);
    if (!response.ok) {
      setError("Unable to load test history.");
      setLoading(false);
      return;
    }
    const data = (await response.json()) as { items: RunItem[] };
    setItems(data.items);
    setLoading(false);
  }, [filter, search, browser]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 180);
    return () => clearTimeout(timer);
  }, [load]);

  // Keep the list fresh while any run is still queued or executing.
  const hasActive = items.some((item) => isActiveRunStatus(item.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={`min-h-[40px] rounded-full border px-4 text-sm font-medium transition-colors ${
                filter === item.key
                  ? "border-transparent bg-[var(--accent)] text-[var(--accent-foreground)]"
                  : "border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="browser-filter" className="sr-only">Filter by browser</label>
          <select
            id="browser-filter"
            value={browser}
            onChange={(event) => setBrowser(event.target.value as "" | "chromium" | "edge" | "firefox")}
            className="min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm outline-none focus:border-[var(--accent)]"
          >
            <option value="">All browsers</option>
            <option value="chromium">Chromium</option>
            <option value="edge">Edge</option>
            <option value="firefox">Firefox</option>
          </select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
            <input
              aria-label="Search test runs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search test runs…"
              className="min-h-[44px] min-w-[220px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] pl-9 pr-3 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card h-20 animate-pulse">
              <div className="h-4 w-1/3 rounded bg-[var(--surface-secondary)]" />
            </div>
          ))}
        </div>
      ) : null}

      {error && !loading ? (
        <Card>
          <p className="text-sm">{error}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
            Retry
          </Button>
        </Card>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--text-secondary)]">
            No test runs match this filter. Run automated tests from the analysis workbench.
          </p>
        </Card>
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <Card padding={false}>
          <div className="hidden grid-cols-12 gap-3 border-b border-[var(--border)] px-5 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] md:grid">
            <span className="col-span-5">Extension</span>
            <span className="col-span-2">Score</span>
            <span className="col-span-2">Status</span>
            <span className="col-span-2">Tests</span>
            <span className="col-span-1 text-right">Date</span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {items.map((item) => (
              <Link
                key={item.id}
                href={`/dashboard/tests/${item.id}`}
                className="grid grid-cols-1 gap-2 px-5 py-4 hover:bg-[var(--surface-secondary)] md:grid-cols-12 md:items-center"
              >
                <span className="col-span-5 min-w-0">
                  <span className="block truncate text-sm font-medium">{item.extensionName ?? "Extension"}</span>
                  <span className="block truncate text-xs text-[var(--text-secondary)]">
                    {item.extensionVersion ? `v${item.extensionVersion} · ` : ""}
                    {browserLabel(item.browserId)}
                    {item.browserVersion ? ` ${item.browserVersion}` : ""}
                    {item.matrixRunId ? " · matrix" : ""} · {relativeTime(item.created_at)}
                  </span>
                </span>
                <span className="col-span-2 text-sm font-semibold">{runScoreLabel(item)}</span>
                <span className="col-span-2">
                  <Badge tone={runOutcomeTone(item)}>{runOutcomeLabel(item)}</Badge>
                </span>
                <span className="col-span-2 text-sm text-[var(--text-secondary)]">
                  {isActiveRunStatus(item.status) && item.stage
                    ? item.stage
                    : `${item.passed + item.failed + item.warnings + item.skipped}/${item.total} completed`}
                </span>
                <span className="col-span-1 text-right text-xs text-[var(--text-secondary)] md:text-sm">
                  {relativeTime(item.created_at)}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}


