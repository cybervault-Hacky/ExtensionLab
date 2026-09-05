"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

interface ReportOption {
  id: string;
  title: string;
  extensionName: string | null;
  created_at: number;
  health_score: number | null;
  runtime_score: number | null;
  overall_score: number | null;
}

interface CompareResponse {
  before: { id: string; title: string; healthScore: number | null; runtimeScore: number | null; overallScore: number | null; createdAt: number };
  after: { id: string; title: string; healthScore: number | null; runtimeScore: number | null; overallScore: number | null; createdAt: number };
  rows: Array<{ field: string; label: string; before: number | null; after: number | null; direction: "improved" | "worsened" | "unchanged" }>;
  changes: Array<{ label: string; value: string; direction: "improved" | "worsened" | "unchanged"; field: string }>;
}

export function ReportsCompare() {
  const [reports, setReports] = useState<ReportOption[]>([]);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadReports = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/reports?page=1&limit=50");
    if (!response.ok) {
      setError("Unable to load reports.");
      setLoading(false);
      return;
    }
    const result = (await response.json()) as { items: ReportOption[] };
    setReports(result.items);
    if (result.items.length >= 2) {
      setLeft(result.items[1].id);
      setRight(result.items[0].id);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  useEffect(() => {
    if (!left || !right || left === right) return;
    setError(null);
    const params = new URLSearchParams({ a: left, b: right });
    void fetch(`/api/reports/compare?${params.toString()}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
          setError(body?.error?.message ?? "Unable to compare reports.");
          return;
        }
        setData((await response.json()) as CompareResponse);
      })
      .catch(() => setError("Unable to compare reports."));
  }, [left, right]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-2 block text-sm font-medium">Before</span>
          <select
            value={left}
            onChange={(event) => setLeft(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
          >
            {reports.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium">After</span>
          <select
            value={right}
            onChange={(event) => setRight(event.target.value)}
            className="min-h-[48px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm"
          >
            {reports.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <div className="card h-40 animate-pulse" />
      ) : null}

      {error ? (
        <Card>
          <p className="text-sm text-[var(--text-secondary)]">{error}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void loadReports()}>
            Retry
          </Button>
        </Card>
      ) : null}

      {!loading && !error && reports.length < 2 ? (
        <Card>
          <p className="text-sm text-[var(--text-secondary)]">Create at least two reports to compare versions.</p>
        </Card>
      ) : null}

      {data ? (
        <Card padding={false}>
          <div className="grid grid-cols-3 gap-px border-b border-[var(--border)] bg-[var(--border)] text-sm">
            <div className="bg-[var(--surface)] p-4">Metric</div>
            <div className="bg-[var(--surface)] p-4">
              <p className="text-xs text-[var(--text-secondary)]">Before</p>
              <p className="mt-1 truncate font-medium">{data.before.title}</p>
            </div>
            <div className="bg-[var(--surface)] p-4">
              <p className="text-xs text-[var(--text-secondary)]">After</p>
              <p className="mt-1 truncate font-medium">{data.after.title}</p>
            </div>
          </div>
          {data.rows.map((row) => (
            <div key={row.field} className="grid grid-cols-3 gap-px border-b border-[var(--border)] bg-[var(--border)] text-sm last:border-b-0">
              <div className="bg-[var(--surface)] p-4">{row.label}</div>
              <div className="bg-[var(--surface)] p-4 text-[var(--text-secondary)]">{row.before ?? "—"}</div>
              <div className="bg-[var(--surface)] p-4 font-medium">{row.after ?? "—"}</div>
            </div>
          ))}
          <div className="bg-[var(--surface)] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Change Detection</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {data.changes.map((change) => (
                <span key={change.field} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1 text-sm">
                  {change.direction === "improved" ? <ArrowUp className="h-4 w-4 text-[var(--status-success)]" aria-hidden="true" /> : null}
                  {change.direction === "worsened" ? <ArrowDown className="h-4 w-4 text-[var(--status-error)]" aria-hidden="true" /> : null}
                  {change.direction === "unchanged" ? <Minus className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" /> : null}
                  {change.label} {change.value}
                </span>
              ))}
            </div>
          </div>
        </Card>
      ) : null}

      {data ? (
        <div className="flex flex-wrap gap-3">
          <Link href={`/dashboard/reports/${data.before.id}`} className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-secondary)] px-5 text-sm font-medium hover:bg-[var(--surface)]">
            Open before report
          </Link>
          <Link href={`/dashboard/reports/${data.after.id}`} className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent)] px-5 text-sm font-medium text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]">
            Open after report
          </Link>
        </div>
      ) : null}
    </div>
  );
}


