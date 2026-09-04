import type { Metadata } from "next";
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
    <div>
      <p className="eyebrow">Phase 3</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Isolated Runtime Testing</h1>
      <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
        Chromium runs in a fresh disposable container. Runtime events below come
        from the sandbox only.
      </p>
      <div className="mt-6">
        <TesterApp initialSandboxId={params.id} />
      </div>
    </div>
  );
}
