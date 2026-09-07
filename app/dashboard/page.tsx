import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Upload, ScanSearch, Monitor, FlaskConical } from "lucide-react";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";
import { Button } from "@/components/ui/Button";

export const metadata: Metadata = { title: "ExtensionLab — Overview" };
export const dynamic = "force-dynamic";

export default async function DashboardOverviewPage() {
  const cookieStore = await cookies();
  const user = restoreUser(cookieStore.get(SESSION_COOKIE)?.value ?? "");
  if (!user) redirect("/login?next=%2Fdashboard");
  const firstName = user.name?.split(" ")[0] || "there";

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 space-y-10">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Good to see you, {firstName}</h1>
        <p className="mt-2 text-sm text-gray-500">Test, analyze and understand your browser extensions.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Link href="/dashboard/upload" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition">
          <div className="mb-4 inline-flex items-center justify-center rounded-xl bg-emerald-50 p-3 text-emerald-600">
            <Upload className="h-6 w-6" aria-hidden="true" />
          </div>
          <h3 className="text-base font-medium">Upload Extension</h3>
          <p className="mt-1 text-xs text-gray-500">Start with your ZIP file.</p>
        </Link>
        <Link href="/dashboard/analyze" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition">
          <div className="mb-4 inline-flex items-center justify-center rounded-xl bg-blue-50 p-3 text-blue-600">
            <ScanSearch className="h-6 w-6" aria-hidden="true" />
          </div>
          <h3 className="text-base font-medium">Analyze Extension</h3>
          <p className="mt-1 text-xs text-gray-500">Static security and quality scan.</p>
        </Link>
        <Link href="/dashboard/browser" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition">
          <div className="mb-4 inline-flex items-center justify-center rounded-xl bg-purple-50 p-3 text-purple-600">
            <Monitor className="h-6 w-6" aria-hidden="true" />
          </div>
          <h3 className="text-base font-medium">Open Live Browser</h3>
          <p className="mt-1 text-xs text-gray-500">Test interactively in isolation.</p>
        </Link>
        <Link href="/dashboard/tests/studio" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition">
          <div className="mb-4 inline-flex items-center justify-center rounded-xl bg-amber-50 p-3 text-amber-600">
            <FlaskConical className="h-6 w-6" aria-hidden="true" />
          </div>
          <h3 className="text-base font-medium">Run Tests</h3>
          <p className="mt-1 text-xs text-gray-500">Automated tests and regression.</p>
        </Link>
      </div>

      <section aria-label="Recent activity">
        <h2 className="text-lg font-medium tracking-tight">Recent activity</h2>
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium">Extensions</h3>
            <Link href="/dashboard/extensions" className="text-xs underline">View all</Link>
          </div>
          <p className="text-sm text-gray-500">Upload your first extension to begin analyzing and testing.</p>
          <div className="mt-4">
            <Button href="/dashboard/upload" variant="accent">Upload Extension</Button>
          </div>
        </div>
      </section>
    </div>
  );
}
