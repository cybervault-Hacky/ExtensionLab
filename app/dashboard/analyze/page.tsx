import type { Metadata } from "next";
import { Workbench } from "@/components/extension/Workbench";

export const metadata: Metadata = { title: "Analyze extension" };

export default function AnalyzePage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Analyze an extension</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Upload a ZIP to create a persistent extension project and analysis snapshot.
      </p>
      <div className="mt-6">
        <Workbench />
      </div>
    </div>
  );
}
