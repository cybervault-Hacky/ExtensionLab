import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Activity, FileText, RotateCcw } from "lucide-react";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";
import { getOwnedExtension } from "@/lib/db/repositories/extensions";
import { getLatestSnapshot, listSnapshots } from "@/lib/db/repositories/snapshots";
import { listTestRunsForExtension } from "@/lib/db/repositories/test-runs";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { isSafeId } from "@/lib/auth/validation";

export const metadata: Metadata = { title: "Extension" };
export const dynamic = "force-dynamic";

export default async function ExtensionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isSafeId(id)) notFound();
  const cookieStore = await cookies();
  const user = restoreUser(cookieStore.get(SESSION_COOKIE)?.value ?? "");
  if (!user) redirect("/login");
  const extension = getOwnedExtension(user.id, id);
  if (!extension) notFound();

  const snapshot = getLatestSnapshot(id);
  const snapshots = listSnapshots(id, 20);
  const runs = listTestRunsForExtension(id, 10);

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow">My Extension</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{extension.name}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{extension.manifest_version?.toUpperCase() ?? "Unknown"}</Badge>
          {extension.version ? <Badge tone="neutral">v{extension.version}</Badge> : null}
          {extension.last_test_status ? (
            <Badge tone={testTone(extension.last_test_status)}>{extension.last_test_status}</Badge>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <p className="text-sm text-[var(--text-secondary)]">Health</p>
          <p className="mt-1 text-4xl font-semibold tracking-tight">{extension.health_score}<span className="text-lg text-[var(--text-secondary)]">/100</span></p>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            {snapshot ? `Analyzed ${relativeTime(snapshot.created_at)}` : "No analysis snapshot yet."}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-[var(--text-secondary)]">Last test</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{extension.last_test_status ? extension.last_test_status : "Not tested"}</p>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            {extension.last_tested_at ? `Tested ${relativeTime(extension.last_tested_at)}` : "No automated test run yet."}
          </p>
        </Card>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button href="/dashboard" variant="secondary">
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Analyze Again
        </Button>
        <Button href={`/dashboard/tests?extensionId=${extension.id}`} variant="accent">
          <Activity className="h-4 w-4" aria-hidden="true" />
          Run Tests
        </Button>
        <Button href={`/dashboard/reports?extensionId=${extension.id}`} variant="secondary">
          <FileText className="h-4 w-4" aria-hidden="true" />
          View Reports
        </Button>
      </div>

      <Card>
        <h2 className="text-base font-semibold tracking-tight">Analysis history</h2>
        {snapshots.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--text-secondary)]">No analysis history.</p>
        ) : (
          <div className="mt-4 divide-y divide-[var(--border)]">
            {snapshots.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Health {item.health_score}/100</p>
                  <p className="text-xs text-[var(--text-secondary)]">{relativeTime(item.created_at)}</p>
                </div>
                <span className="text-xs text-[var(--text-secondary)]">{item.manifest_version ?? "Unknown"}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-base font-semibold tracking-tight">Recent test runs</h2>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--text-secondary)]">No automated test runs yet.</p>
        ) : (
          <div className="mt-4 divide-y divide-[var(--border)]">
            {runs.map((run) => (
              <Link key={run.id} href={`/dashboard/tests/${run.id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-[var(--surface-secondary)]">
                <div>
                  <p className="text-sm font-medium">{run.score}/100</p>
                  <p className="text-xs text-[var(--text-secondary)]">{relativeTime(run.created_at)}</p>
                </div>
                <Badge tone={testTone(run.status)}>{run.status}</Badge>
              </Link>
            ))}
          </div>
        )}
      </Card>
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

function testTone(status: string): "success" | "error" | "warning" | "info" | "neutral" {
  if (["completed", "passed"].includes(status)) return "success";
  if (["failed", "timeout", "error"].includes(status)) return "error";
  if (["running", "idle", "preparing", "starting", "stopping"].includes(status)) return "info";
  return "neutral";
}
