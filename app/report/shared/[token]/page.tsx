import type { Metadata } from "next";
import { getSharedPublicReport } from "@/lib/db/repositories/shared-reports";
import { Logo } from "@/components/layout/Logo";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export const metadata: Metadata = { title: "Shared report" };
export const dynamic = "force-dynamic";

export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const report = getSharedPublicReport(token);

  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-12 sm:py-16">
      <div className="w-full max-w-2xl">
        <Logo />
        {!report ? (
          <Card className="mt-8 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Report unavailable</h1>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              This shared link is unavailable. It may have been revoked or the expiration time has passed.
            </p>
          </Card>
        ) : (
          <div className="mt-8 space-y-5">
            <div>
              <p className="eyebrow">Extension Test Report</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight">{String(report.title)}</h1>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Extension: {String(report.extension ?? "Browser extension")}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Stat label="Health" value={String(report.staticScore ?? "—")} />
              <Stat label="Runtime" value={String(report.runtimeScore ?? "—")} />
              <Stat label="Tests" value={summaryText(report.tests)} />
            </div>

            <Card>
              <h2 className="text-base font-semibold tracking-tight">Findings</h2>
              {Array.isArray(report.findings) && report.findings.length > 0 ? (
                <div className="mt-4 space-y-3">
                  {(report.findings as Array<Record<string, unknown>>).map((finding, index) => (
                    <div key={index} className="rounded-xl border border-[var(--border)] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{String(finding.title ?? "Finding")}</p>
                        <Badge tone={severityTone(String(finding.severity))}>{String(finding.severity)}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-[var(--text-secondary)]">{String(finding.description ?? "")}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-[var(--text-secondary)]">No findings in this snapshot.</p>
              )}
            </Card>

            <p className="text-center text-sm text-[var(--text-secondary)]">Generated with ExtensionLab</p>
          </div>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-sm text-[var(--text-secondary)]">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
    </Card>
  );
}

function summaryText(summary: unknown): string {
  if (!summary || typeof summary !== "object") return "—";
  const record = summary as Record<string, unknown>;
  const passed = record.passed ?? 0;
  const failed = record.failed ?? 0;
  const warnings = record.warnings ?? 0;
  return `${passed} passed · ${failed} failed · ${warnings} warnings`;
}

function severityTone(severity: string): "success" | "error" | "warning" | "info" | "neutral" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium" || severity === "warning") return "warning";
  if (severity === "low" || severity === "info") return "info";
  return "neutral";
}
