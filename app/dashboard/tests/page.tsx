import type { Metadata } from "next";
import Link from "next/link";
import { TestsList } from "@/components/workspace/TestsList";

export const metadata: Metadata = { title: "Test Runs" };

/**
 * /dashboard/tests (Phase 15 §74): test hub. Recent Runs lives here; the
 * Studio (saved tests + suites) and its detail pages branch off /studio.
 */
export default function TestsPage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Tests</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Persistent automated test history from your isolated browser sandbox. Build repeatable saved tests in the{" "}
        <Link href="/dashboard/tests/studio" className="underline focus-visible:outline-2">
          Test Automation Studio
        </Link>
        .
      </p>
      <div className="mt-6">
        <TestsList />
      </div>
    </div>
  );
}
