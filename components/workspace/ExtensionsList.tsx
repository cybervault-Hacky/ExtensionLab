"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

interface ExtensionItem {
  id: string;
  name: string;
  version: string | null;
  manifest_version: string | null;
  source_name: string | null;
  health_score: number;
  status: string;
  last_tested_at: number | null;
  last_test_status: string | null;
  created_at: number;
}

export function ExtensionsList() {
  const [items, setItems] = useState<ExtensionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: "1", limit: "50", sort });
    if (search.trim()) params.set("q", search.trim());
    const response = await fetch(`/api/extensions?${params.toString()}`);
    if (!response.ok) {
      setError("Unable to load extensions.");
      setLoading(false);
      return;
    }
    const data = (await response.json()) as { items: ExtensionItem[] };
    setItems(data.items);
    setLoading(false);
  }, [search, sort]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
          <input
            aria-label="Search extensions"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search extensions…"
            className="min-h-[44px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] pl-9 pr-3 text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
        <select
          aria-label="Sort extensions"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
          className="min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="name">Name</option>
          <option value="health_desc">Highest score</option>
          <option value="health_asc">Lowest score</option>
        </select>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card h-28 animate-pulse">
              <div className="h-4 w-1/2 rounded bg-[var(--surface-secondary)]" />
              <div className="mt-3 h-3 w-1/3 rounded bg-[var(--surface-secondary)]" />
            </div>
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
        <Card className="text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <Upload className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-xl font-semibold tracking-tight">No extensions yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-secondary)]">
            Upload and analyze a browser extension to save it to your workspace.
          </p>
          <Button href="/dashboard/analyze" variant="accent" className="mt-5">
            Analyze an extension
          </Button>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {!loading && !error
          ? items.map((item) => (
              <Link key={item.id} href={`/dashboard/extensions/${item.id}`} className="card card-pad transition-transform duration-200 hover:scale-[1.01] hover:shadow-soft">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-base font-semibold">{item.name}</h3>
                      <Badge tone="neutral">{item.manifest_version?.toUpperCase() ?? "Unknown"}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      Health {item.health_score}/100
                      {item.version ? ` · v${item.version}` : ""}
                    </p>
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">
                      {item.last_test_status ? (
                        <Badge tone={lastTone(item.last_test_status)}>{item.last_test_status}</Badge>
                      ) : (
                        <span>Not tested yet</span>
                      )}
                    </p>
                  </div>
                  <ArrowUpRight className="h-5 w-5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                </div>
              </Link>
            ))
          : null}
      </div>
    </div>
  );
}

function lastTone(status: string): "success" | "error" | "warning" | "info" | "neutral" {
  if (["completed", "passed"].includes(status)) return "success";
  if (["failed", "timeout", "error"].includes(status)) return "error";
  if (["running", "idle", "preparing", "starting", "stopping"].includes(status)) return "info";
  return "neutral";
}
