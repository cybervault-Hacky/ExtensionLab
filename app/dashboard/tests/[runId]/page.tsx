import type { Metadata } from "next";
import { cookies } from "next/headers";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";
import { getOwnedTestRun } from "@/lib/db/repositories/test-runs";
import { getOwnedPackage } from "@/lib/db/repositories/packages";
import { TestRunBrowser } from "@/components/tester/TestRunBrowser";
import { OpenInteractiveBrowserButton } from "@/components/interactive/OpenInteractiveBrowserButton";
import { Card } from "@/components/ui/Card";
import { isSafeId } from "@/lib/auth/validation";

export const metadata: Metadata = { title: "Automated Test Report" };
export const dynamic = "force-dynamic";

/**
 * Automated test report. When the underlying package is still available, the
 * page offers "Open in Interactive Browser" against the SAME package version
 * the run tested (Phase 11 integration with the Phase 4 engine).
 */
export default async function AutomatedTestReportPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  let packageId: string | null = null;
  let packageLabel: string | null = null;
  if (isSafeId(runId)) {
    const cookieStore = await cookies();
    const user = restoreUser(cookieStore.get(SESSION_COOKIE)?.value ?? "");
    const run = user ? getOwnedTestRun(user.id, runId) : null;
    const pkg = run?.package_id ? getOwnedPackage(user!.id, run.package_id) : null;
    if (pkg) {
      packageId = pkg.id;
      packageLabel = pkg.version ? `v${pkg.version} · ${pkg.sha256.slice(0, 12)}…` : `SHA-256 ${pkg.sha256.slice(0, 12)}…`;
    }
  }

  return (
    <div className="space-y-4">
      <TestRunBrowser runId={runId} />
      {packageId ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight">Explore this run interactively</h2>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                Open the exact package this run tested ({packageLabel}) in a disposable interactive browser.
              </p>
            </div>
            <OpenInteractiveBrowserButton packageId={packageId} label="Open in Interactive Browser" />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
