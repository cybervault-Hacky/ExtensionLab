"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  Download,
  FileText,
  Link2,
  Lock,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

interface ReportView {
  report: {
    id: string;
    title: string;
    summary: string | null;
    healthScore: number | null;
    runtimeScore: number | null;
    overallScore: number | null;
    createdAt: number;
    extensionId: string | null;
    analysisSnapshotId: string | null;
    testRunId: string | null;
  };
  extension: { name: string | null; version: string | null };
  staticAnalysis: { healthScore: number | null; issues: unknown[] };
  runtimeTests: {
    score: number | null;
    summary: Record<string, unknown> | null;
  };
  findings: Array<{ id?: string; severity: string; category: string; title: string; description: string; recommendation: string; evidence: string[] }>;
}

export function ReportDetail({ reportId }: { reportId: string }) {
  const [data, setData] = useState<ReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await fetch(`/api/reports/${reportId}`);
    if (!response.ok) {
      setError("Report not found.");
      setLoading(false);
      return;
    }
    setData((await response.json()) as ReportView);
    setLoading(false);
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const share = useCallback(
    async (expiresInHours: number) => {
      setBusy(true);
      try {
        const response = await fetch(`/api/reports/${reportId}/share`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expiresInHours }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
          setError(body?.error?.message ?? "The share link could not be created.");
          return;
        }
        const result = (await response.json()) as { url: string };
        const absolute = new URL(result.url, window.location.origin).toString();
        setShareUrl(absolute);
      } finally {
        setBusy(false);
      }
    },
    [reportId],
  );

  const revoke = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/reports/${reportId}/share`, { method: "DELETE" });
      if (response.ok) setShareUrl(null);
    } finally {
      setBusy(false);
    }
  }, [reportId]);

  const copyShare = useCallback(async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [shareUrl]);

  const exportJson = useCallback(async () => {
    const response = await fetch(`/api/reports/${reportId}`);
    const payload = await response.json();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extensionlab-report-${reportId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [reportId]);

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
        <p className="text-sm text-[var(--text-secondary)]">{error ?? "Unable to load reports."}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
          Retry
        </Button>
      </Card>
    );
  }

  const summary = data.runtimeTests.summary ?? {};

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="eyebrow">ExtensionLab Report</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{data.report.title}</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            {data.extension.name ?? "Extension"}
            {data.extension.version ? ` · v${data.extension.version}` : ""} · {relativeTime(data.report.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void exportJson()}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Export JSON
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ScoreCard label="Static Analysis" score={data.staticAnalysis.healthScore} />
        <ScoreCard label="Runtime Tests" score={data.runtimeTests.score} />
        <ScoreCard label="Overall" score={data.report.overallScore} accent />
      </div>

      <Card>
        <div className="flex items-center gap-2">
          <Share2 className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />
          <h2 className="text-base font-semibold tracking-tight">Share report</h2>
        </div>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          A public link exposes only safe summarized report data. No email, credentials or private source is shared.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" loading={busy && !shareUrl} onClick={() => void share(0)}>
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Never expires
          </Button>
          <Button variant="secondary" size="sm" loading={busy && !shareUrl} onClick={() => void share(24)}>
            24 hours
          </Button>
          <Button variant="secondary" size="sm" loading={busy && !shareUrl} onClick={() => void share(168)}>
            7 days
          </Button>
          <Button variant="secondary" size="sm" loading={busy && !shareUrl} onClick={() => void share(720)}>
            30 days
          </Button>
        </div>
        {shareUrl ? (
          <div className="mt-4 flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-3 sm:flex-row sm:items-center sm:justify-between">
            <a href={shareUrl} target="_blank" rel="noreferrer" className="truncate text-sm font-medium text-[var(--accent)]">
              {shareUrl}
            </a>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => void copyShare()}>
                <Copy className="h-4 w-4" aria-hidden="true" />
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="secondary" size="sm" loading={busy} onClick={() => void revoke()}>
                <Lock className="h-4 w-4" aria-hidden="true" />
                Revoke Link
              </Button>
            </div>
          </div>
        ) : null}
        {error ? <p className="mt-3 text-sm text-[var(--status-error)]">{error}</p> : null}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold tracking-tight">Test Results</h2>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ResultStat label="Total" value={String(number(summary.total))} />
            <ResultStat label="Passed" value={String(number(summary.passed))} tone="success" />
            <ResultStat label="Failed" value={String(number(summary.failed))} tone="error" />
            <ResultStat label="Warnings" value={String(number(summary.warnings))} tone="warning" />
          </div>
        </Card>

        <Card>
          <h2 className="text-base font-semibold tracking-tight">Diagnostics</h2>
          {data.findings.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--text-secondary)]">No significant diagnostics in this snapshot.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {data.findings.slice(0, 8).map((finding, index) => (
                <div key={`${finding.title}-${index}`} className="rounded-xl border border-[var(--border)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{finding.title}</p>
                    <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">{finding.description}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="text-base font-semibold tracking-tight">Findings</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Static analysis findings from the saved snapshot.
        </p>
        <div className="mt-4 space-y-2">
          {data.staticAnalysis.issues.length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)]">No static issues recorded.</p>
          ) : (
            data.staticAnalysis.issues.map((issue) => {
              const item = issue as Record<string, unknown>;
              return (
                <div key={String(item.id ?? issue)} className="flex items-start gap-3 rounded-xl border border-[var(--border)] p-3">
                  <Badge tone={severityTone(String(item.severity))}>{String(item.severity)}</Badge>
                  <div>
                    <p className="text-sm font-medium">{String(item.title ?? "Finding")}</p>
                    <p className="text-sm text-[var(--text-secondary)]">{String(item.message ?? "")}</p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>

      <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <FileText className="h-4 w-4" aria-hidden="true" />
        Generated with ExtensionLab from an immutable analysis and test snapshot.
      </div>
    </div>
  );
}

function ScoreCard({ label, score, accent }: { label: string; score: number | null; accent?: boolean }) {
  return (
    <Card>
      <p className="text-sm text-[var(--text-secondary)]">{label}</p>
      <p className={accent ? "mt-1 text-4xl font-semibold tracking-tight text-[var(--accent)]" : "mt-1 text-4xl font-semibold tracking-tight"}>
        {score ?? "—"}
        <span className="text-lg font-normal text-[var(--text-secondary)]">/100</span>
      </p>
    </Card>
  );
}

function ResultStat({ label, value, tone }: { label: string; value: string; tone?: "success" | "error" | "warning" }) {
  const color =
    tone === "success"
      ? "text-[var(--status-success)]"
      : tone === "error"
        ? "text-[var(--status-error)]"
        : tone === "warning"
          ? "text-[var(--status-warning)]"
          : "";
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight ${color}`}>{value}</p>
    </div>
  );
}

function number(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "string" ? Number(value) || 0 : 0;
}

function severityTone(severity: string): "success" | "error" | "warning" | "info" | "neutral" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium" || severity === "warning") return "warning";
  if (severity === "low" || severity === "info") return "info";
  return "neutral";
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
