import type { Metadata } from "next";
import { ReportsList } from "@/components/workspace/ReportsList";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Reports</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Immutable analysis and test reports with secure sharing.
      </p>
      <div className="mt-6">
        <ReportsList />
      </div>
    </div>
  );
}
