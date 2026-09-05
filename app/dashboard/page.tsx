import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Activity, ArrowUpRight, FileText, FolderOpen, Upload } from "lucide-react";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";
import { listExtensions } from "@/lib/db/repositories/extensions";
import { listTestRuns, countTestRuns } from "@/lib/db/repositories/test-runs";
import { listReports, countReports } from "@/lib/db/repositories/reports";
import { countExtensions } from "@/lib/db/repositories/extensions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { runHasExecutedTests, runOutcomeLabel, runScoreLabel } from "@/lib/testing/status-labels";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function DashboardOverviewPage() {
  const cookieStore = await cookies();
  const user = restoreUser(cookieStore.get(SESSION_COOKIE)?.value ?? "");
  if (!user) redirect("/login?next=%2Fdashboard");
  const userId = user.id;

  const [extensionsData, testData, reportData, extensionCount, runCount, reportCount] = [
    listExtensions(userId, { page: 1, limit: 4 }),
    listTestRuns(userId, { page: 1, limit: 4 }),
    listReports(userId, { page: 1, limit: 4 }),
    countExtensions(userId),
    countTestRuns(userId),
    countReports(userId),
  ];

  const completed = testData.items.filter((run) => runHasExecutedTests(run));
  const averageScore =
    completed.length > 0
      ? Math.round(completed.reduce((sum, run) => sum + run.score, 0) / completed.length)
      : 0;
  const issuesFound = completed.reduce(
    (sum, run) => sum + run.failed + run.error_count + run.timeout,
    0,
  );

  const greeting = "Good morning";
  const firstName = user.name.split(" ")[0] || "there";

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">Overview</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {greeting}, {firstName}
          </h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Your ExtensionLab workspace at a glance.
          </p>
        </div>
        <Button href="/dashboard/analyze" variant="accent">
          <Upload className="h-4 w-4" aria-hidden="true" />
          Add Extension
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <OverviewStat icon={FolderOpen} label="Extensions" value={String(extensionCount)} />
        <OverviewStat icon={Activity} label="Tests Run" value={String(runCount)} />
        <OverviewStat icon={ArrowUpRight} label="Average Score" value={averageScore ? `${averageScore}` : "—"} />
        <OverviewStat icon={FileText} label="Issues Found" value={String(issuesFound)} />
      </div>

      {extensionCount === 0 ? (
        <Card className="text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <Upload className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-xl font-semibold tracking-tight">Welcome to ExtensionLab</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-secondary)]">
            Upload your first browser extension to analyze and test it.
          </p>
          <Button href="/dashboard/analyze" variant="accent" className="mt-5">
            Add Extension
          </Button>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <RecentSection
          title="Recent Extensions"
          empty="No extensions yet."
          href="/dashboard/analyze"
          items={extensionsData.items.map((item) => ({
            id: item.id,
            title: item.name,
            sub: `${item.manifest_version?.toUpperCase() ?? "Unknown"} · Health ${item.health_score}`,
            href: `/dashboard/extensions/${item.id}`,
            badge: item.last_test_status ? runOutcomeLabel({ status: item.last_test_status }) : null,
          }))}
        />
        <RecentSection
          title="Recent Test Runs"
          empty="No test runs yet."
          href="/dashboard/tests"
          items={testData.items.map((item) => ({
            id: item.id,
            title: item.extensionName ?? "Extension",
            sub: `${runScoreLabel(item)} · ${runOutcomeLabel(item)}`,
            href: `/dashboard/tests/${item.id}`,
            badge: item.status ? runOutcomeLabel(item) : null,
          }))}
        />
        <RecentSection
          title="Recent Reports"
          empty="No reports yet."
          href="/dashboard/reports"
          items={reportData.items.map((item) => ({
            id: item.id,
            title: item.title,
            sub: `Overall ${item.overall_score ?? "—"}/100`,
            href: `/dashboard/reports/${item.id}`,
            badge: null,
          }))}
        />
      </div>
    </div>
  );
}

function OverviewStat({ icon: Icon, label, value }: { icon: typeof FolderOpen; label: string; value: string }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm text-[var(--text-secondary)]">{label}</p>
          <p className="text-2xl font-semibold tracking-tight">{value}</p>
        </div>
      </div>
    </Card>
  );
}

function RecentSection({
  title,
  empty,
  href,
  items,
}: {
  title: string;
  empty: string;
  href: string;
  items: Array<{ id: string; title: string; sub: string; href: string; badge: string | null }>;
}) {
  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <Link href={href} className="text-sm font-medium text-[var(--accent)] hover:underline">
          View all
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">{empty}</p>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {items.map((item) => (
            <Link key={item.id} href={item.href} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 hover:bg-[var(--surface-secondary)]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="truncate text-xs text-[var(--text-secondary)]">{item.sub}</p>
              </div>
              {item.badge ? <Badge tone={badgeTone(item.badge)}>{item.badge}</Badge> : null}
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}


function badgeTone(
  status: string,
): "success" | "error" | "warning" | "info" | "neutral" {
  if (status === "Passed") return "success";
  if (status === "Failed" || status === "Timeout") return "error";
  if (status === "Warnings" || status === "Infrastructure error") return "warning";
  if (status === "Running" || status === "Queued") return "info";
  return "neutral";
}
