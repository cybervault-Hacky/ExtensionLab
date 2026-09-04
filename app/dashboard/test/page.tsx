import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { TesterApp } from "@/components/tester/TesterApp";

export const metadata: Metadata = {
  title: "Sandbox Runtime",
  description:
    "Run a browser extension inside an isolated disposable Chromium sandbox.",
};

export default async function RuntimeTesterPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const params = await searchParams;
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
            <p className="eyebrow">Phase 3</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Isolated Runtime Testing
            </h1>
            <p className="mt-2 max-w-2xl text-[var(--text-secondary)]">
              Chromium runs in a fresh disposable container. Runtime events
              below come from the sandbox only.
            </p>
          </div>
        </div>
        <TesterApp initialSandboxId={params.id} />
      </main>
      <Footer />
    </div>
  );
}
