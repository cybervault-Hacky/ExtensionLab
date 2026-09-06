import type { Metadata } from "next";
import { TestStudio } from "@/components/studio/TestStudio";

export const metadata: Metadata = { title: "Test Automation Studio" };

/**
 * /dashboard/tests/studio — Test Automation Studio (Phase 15).
 * Build repeatable extension tests from the safe action/assertion allowlist:
 * no JavaScript, no shell, no browser automation code.
 */
export default function StudioPage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Test Automation Studio</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Repeatable extension tests built from allowlisted actions and assertions — no JavaScript, shell commands or browser automation code. Saved tests
        bind to the exact package bytes they were authored against and run in a fresh isolated browser through the same queue as every other run.
      </p>
      <div className="mt-6">
        <TestStudio />
      </div>
    </div>
  );
}
