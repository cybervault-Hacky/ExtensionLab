import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicReportBySlug } from "@/lib/reports/publications";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const report = getPublicReportBySlug(slug);
  return { title: report ? `${report.title} — ExtensionLab` : "Report not found" };
}

/**
 * Public report page. Reports are private by default; this page only renders
 * the safe public projection (scores, browser outcomes, provenance labels) —
 * never organization identity, source, or infrastructure details.
 */
export default async function PublicReportPage({ params }: PageProps) {
  const { slug } = await params;
  const report = getPublicReportBySlug(slug);
  if (!report) notFound();
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Public report</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">{report.title}</h1>
      {report.summary ? <p className="mt-3 text-slate-600">{report.summary}</p> : null}
      <div className="mt-8 grid grid-cols-3 gap-4">
        {[
          { label: "Overall", value: report.scores.overall },
          { label: "Health", value: report.scores.health },
          { label: "Runtime", value: report.scores.runtime },
        ].map((score) => (
          <div key={score.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{score.label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{score.value === null ? "—" : score.value}</p>
          </div>
        ))}
      </div>
      {report.compatibility ? (
        <p className="mt-6 text-sm text-slate-600">
          Cross-browser compatibility score {report.compatibility.score}/100 (coverage {report.compatibility.coverage}%).
        </p>
      ) : null}
      {report.browsers.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-slate-900">Browsers</h2>
          <ul className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {report.browsers.map((browser) => (
              <li key={browser.browserId} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium text-slate-800">{browser.browserId}</span>
                <span className={browser.executed && browser.status === "completed" ? "text-emerald-600" : "text-slate-500"}>
                  {browser.executed ? browser.status : "not executed"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-slate-900">Provenance</h2>
        <ul className="mt-3 space-y-2">
          {report.provenance.map((provenance) => (
            <li key={provenance.label} className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
              <span className="font-medium text-slate-800">{provenance.label}:</span> {provenance.meaning}
            </li>
          ))}
        </ul>
      </section>
      <p className="mt-10 text-xs text-slate-400">Generated {new Date(report.generatedAt).toISOString()} · Schema v{report.schemaVersion}</p>
    </main>
  );
}
