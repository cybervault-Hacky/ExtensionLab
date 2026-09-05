import type { Metadata } from "next";
import { ReportsCompare } from "@/components/workspace/ReportsCompare";

export const metadata: Metadata = { title: "Compare reports" };

export default function ReportsComparePage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Compare reports</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Measure the difference between two immutable report snapshots.
      </p>
      <div className="mt-6">
        <ReportsCompare />
      </div>
    </div>
  );
}
