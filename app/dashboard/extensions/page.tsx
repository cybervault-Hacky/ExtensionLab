import type { Metadata } from "next";
import { ExtensionsList } from "@/components/workspace/ExtensionsList";

export const metadata: Metadata = { title: "Extensions" };

export default function ExtensionsPage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Extensions</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Saved extension projects and their analysis history.
      </p>
      <div className="mt-6">
        <ExtensionsList />
      </div>
    </div>
  );
}
