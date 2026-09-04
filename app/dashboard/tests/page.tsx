import type { Metadata } from "next";
import { TestsList } from "@/components/workspace/TestsList";

export const metadata: Metadata = { title: "Test Runs" };

export default function TestsPage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Test Runs</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Persistent automated test history from your isolated browser sandbox.
      </p>
      <div className="mt-6">
        <TestsList />
      </div>
    </div>
  );
}
