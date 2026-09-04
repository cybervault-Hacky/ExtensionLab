import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { AutomatedTestRunView } from "@/components/tester/AutomatedTestRunView";

export const metadata: Metadata = {
  title: "Automated Test Report",
  description: "Automated browser-extension test results from the isolated sandbox.",
};

export default async function AutomatedTestReportPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="section-width pt-8 pb-20">
        <div className="mb-6">
          <Link
            href="/dashboard"
            className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Analysis
          </Link>
          <div className="mt-3">
            <p className="eyebrow">Phase 4</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Automated Test Report
            </h1>
            <p className="mt-2 max-w-2xl text-[var(--text-secondary)]">
              Deterministic tests that ran inside a fresh disposable Chromium
              sandbox. Every result below reflects real browser evidence.
            </p>
          </div>
        </div>
        <AutomatedTestRunView runId={runId} />
      </main>
      <Footer />
    </div>
  );
}
