"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GitCompareArrows, Search } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

interface ReportItem {
  id: string;
  title: string;
  summary: string | null;
  health_score: number | null;
  runtime_score: number | null;
  overall_score: number | null;
  created_at: number;
  extensionName: string | null;
  extensionVersion: string | null;
}

export function ReportsList() {
  const [items, setItems] = useState<ReportItem[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: "1", limit: "50", sort });
    if (search.trim()) params.set("q", search.trim());
    const response = await fetch(`/api/reports?${params.toString()}`);
    if (!response.ok) {
      setError("Unable to load reports.");
      setLoading(false);
      return;
    }
    const data = (await response.json()) as { items: ReportItem[] };
    setItems(data.items);
    setLoading(false);
  }, [search, sort]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 180);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
          <input
            aria-label="Search reports"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search reports…"
            className="min-h-[44px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] pl-9 pr-3 text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Sort reports"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="score_desc">Highest score</option>
            <option value="score_asc">Lowest score</option>
            <option value="name">Name</option>
          </select>
          <Button href="/dashboard/reports/compare" variant="secondary" size="sm">
            <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
            Compare
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card h-28 animate-pulse" />
          ))}
        </div>
      ) : null}

      {error && !loading ? (
        <Card>
          <p className="text-sm text-[var(--text-secondary)]">{error}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
            Retry
          </Button>
        </Card>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--text-secondary)]">
            No saved reports yet. Generate a report from a test run.
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {!loading && !error
          ? items.map((item) => (
              <Link key={item.id} href={`/dashboard/reports/${item.id}`} className="card card-pad transition-transform duration-200 hover:scale-[1.01] hover:shadow-soft">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold">{item.title}</h3>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      {item.extensionName ?? "Extension"}
                      {item.summary ? ` · ${item.summary}` : ""}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Badge tone="accent">Overall {item.overall_score ?? "—"}/100</Badge>
                      <span className="text-xs text-[var(--text-secondary)]">{relativeTime(item.created_at)}</span>
                    </div>
                  </div>
                </div>
              </Link>
            ))
          : null}
      </div>
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
