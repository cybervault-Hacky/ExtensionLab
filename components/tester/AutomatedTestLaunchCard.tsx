"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, Globe, Loader2, Lock, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PaywallNotice, paywallFromError, type PaywallInfo } from "@/components/billing/PaywallNotice";
import type { ApiErrorPayload } from "@/components/billing/types";
import type { ExtensionAnalysis } from "@/types/extension";

export interface AutomatedTestLaunchCardProps {
  analysis: ExtensionAnalysis;
  sourceFile: File | null;
  testUrl?: string;
  extensionId?: string;
}

export function AutomatedTestLaunchCard({
  analysis,
  sourceFile,
  testUrl = "",
  extensionId,
}: AutomatedTestLaunchCardProps) {
  const router = useRouter();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<PaywallInfo | null>(null);

  const launch = async () => {
    if (!sourceFile) {
      setError("The original extension package is no longer available. Please re-upload it.");
      return;
    }
    setLaunching(true);
    setError(null);
    setPaywall(null);
    try {
      const form = new FormData();
      form.append("file", sourceFile, sourceFile.name);
      if (testUrl.trim() !== "") form.append("testUrl", testUrl);
      if (extensionId) form.append("extensionId", extensionId);
      const response = await fetch("/api/tests/create", { method: "POST", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiErrorPayload | null;
        const limit = paywallFromError(body);
        if (limit) {
          setPaywall(limit);
          return;
        }
        setError(body?.error?.message ?? "The automated test suite could not be prepared.");
        return;
      }
      const created = (await response.json()) as { runId: string; token: string; suite: { total: number } };
      window.sessionStorage.setItem(`extensionlab:test-token:${created.runId}`, created.token);
      // The run is queued durably; the worker executes it in the sandbox.
      router.push(`/dashboard/tests/${created.runId}`);
    } catch {
      setError("We could not reach the ExtensionLab backend. Please try again.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className="card card-pad">
      <div className="flex items-start gap-4">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
          <FlaskConical className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Automated testing</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            Run automated test suite
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            ExtensionLab will run deterministic tests inside a fresh isolated
            browser for {analysis.metadata.name ?? "this extension"}. Results are
            based only on real browser evidence.
          </p>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="automated-test-url" className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <Globe className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
            Test URL
          </label>
          <input
            id="automated-test-url"
            type="url"
            value={testUrl || "Controlled ExtensionLab test origin"}
            readOnly
            className="min-h-[46px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm text-[var(--text-primary)] opacity-80"
          />
          <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            The controlled ExtensionLab test origin is used by default.
          </p>
        </div>
        <Button variant="accent" onClick={() => void launch()} loading={launching} disabled={!sourceFile || launching}>
          {launching ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Queuing automated test run
            </>
          ) : (
            <>
              <Play className="h-4 w-4" aria-hidden="true" />
              Run Automated Tests
            </>
          )}
        </Button>
      </div>

      {paywall ? <PaywallNotice info={paywall} className="mt-4" /> : null}
      {error ? (
        <div className="mt-4 rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-3 text-sm text-[var(--text-primary)]">
          {error}
        </div>
      ) : null}
    </section>
  );
}
