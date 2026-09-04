import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { Workbench } from "@/components/extension/Workbench";

export const metadata: Metadata = {
  title: "Extension Analysis",
  description:
    "Upload and inspect a browser extension package with ExtensionLab Phase 1.",
};

export default function DashboardPage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="section-width pt-10 pb-20">
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Extension Analysis
          </h1>
          <p className="mt-2 max-w-xl text-[var(--text-secondary)]">
            Upload a ZIP package to inspect its manifest, permissions, files and
            configuration. Analysis runs locally and never executes the
            extension.
          </p>
        </div>

        <Workbench />
      </main>
      <Footer />
    </div>
  );
}
