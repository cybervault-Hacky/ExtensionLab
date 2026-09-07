import Link from "next/link";

export default function AnalyticsDashboardPage() {
  return (
    <div className="max-w-4xl space-y-8 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
      <p className="text-sm text-gray-500">Real data from ExtensionLab. No fake metrics. Empty states indicate insufficient or no data.</p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Overview", desc: "Extension health, testing, CI, regressions, performance.", url: "/api/analytics/overview" },
          { title: "Extension Quality", desc: "Health score trends, finding trends, version comparisons.", url: "/api/analytics/extensions/EXT_ID" },
          { title: "Testing", desc: "Pass rate, reliability, failure classification, flaky candidates.", url: "/api/analytics/overview" },
          { title: "Browser Compatibility", desc: "Real browser matrix results with infrastructure separated.", url: "/api/analytics/overview" },
        ].map((s) => (
          <div key={s.title} className="rounded-xl border border-slate-200 bg-slate-800 p-5">
            <h2 className="text-sm font-semibold">{s.title}</h2>
            <p className="mt-1 text-xs text-gray-500">{s.desc}</p>
            <Link href={s.url} className="mt-3 inline-block text-xs underline">API endpoint</Link>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold">Overview (real data)</h2>
        <ul className="mt-2 space-y-1 text-xs text-gray-500 list-disc ml-4">
          <li>Extensions analyzed: based on real analysis_snapshots (30-day window by default)</li>
          <li>Test pass rate: computed from real test_runs with completed/failed status</li>
          <li>CI success rate: computed from test_runs with CI metadata</li>
          <li>Regression count: real regression records (Phase 9/15)</li>
          <li>Average duration: statistical mean from real durations; shown only if &gt;0 samples</li>
        </ul>
        <p className="mt-2 text-xs text-emerald-600">No synthetic data used.</p>
      </div>
    </div>
  );
}
