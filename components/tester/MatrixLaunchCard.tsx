"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Boxes, Loader2, Lock, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BrowserSelector } from "./BrowserSelector";
import { PaywallNotice, paywallFromError, type PaywallInfo } from "@/components/billing/PaywallNotice";
import type { ApiErrorPayload } from "@/components/billing/types";
import type { ExtensionAnalysis } from "@/types/extension";

/**
 * Phase 9 cross-browser matrix launcher. Creates one isolated execution per
 * selected browser (server-side entitlements, quota and availability checks
 * are enforced by the API — this card only sends the selection).
 */
export function MatrixLaunchCard({
  analysis,
  sourceFile,
  extensionId,
}: {
  analysis: ExtensionAnalysis;
  sourceFile: File | null;
  extensionId?: string;
}) {
  const router = useRouter();
  const [browsers, setBrowsers] = useState<string[]>(["chromium"]);
  const [suiteId, setSuiteId] = useState("core");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<PaywallInfo | null>(null);

  const launch = async () => {
    if (!sourceFile) {
      setError("The original extension package is no longer available. Please re-upload it.");
      return;
    }
    if (browsers.length === 0) {
      setError("Select at least one browser.");
      return;
    }
    setLaunching(true);
    setError(null);
    setPaywall(null);
    try {
      const form = new FormData();
      form.append("file", sourceFile, sourceFile.name);
      form.append("browsers", browsers.join(","));
      form.append("suiteId", suiteId);
      if (extensionId) form.append("extensionId", extensionId);
      const response = await fetch("/api/tests/matrix", { method: "POST", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiErrorPayload | null;
        const limit = paywallFromError(body);
        if (limit) {
          setPaywall(limit);
          return;
        }
        setError(body?.error?.message ?? "The browser matrix could not be queued.");
        return;
      }
      const created = (await response.json()) as { matrixRunId: string };
      router.push(`/dashboard/tests/matrix/${created.matrixRunId}`);
    } catch {
      setError("We could not reach the ExtensionLab backend. Please try again.");
    } finally {
      setLaunching(false);
    }
  };

  const suites = [
    { id: "core", name: "Core Extension Suite" },
    { id: "popup-smoke", name: "Popup Smoke Test" },
    { id: "content-script", name: "Content Script Test" },
    { id: "service-worker", name: "Service Worker Test" },
    { id: "permission-smoke", name: "Permission Smoke Test" },
    { id: "advanced", name: "Advanced Diagnostics Suite" },
  ];

  return (
    <section className="card card-pad">
      <div className="flex items-start gap-4">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
          <Boxes className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Cross-browser testing</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">Run a browser matrix</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            The same deterministic suite runs independently in one disposable, isolated browser per
            selection. Results include a compatibility comparison, per-browser diagnostics and
            side-by-side screenshots.
          </p>

          <div className="mt-4">
            <BrowserSelector selected={browsers} onChange={setBrowsers} maxSelectable={3} disabled={launching} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label htmlFor="matrix-suite" className="text-sm text-[var(--text-secondary)]">
              Test suite
            </label>
            <select
              id="matrix-suite"
              value={suiteId}
              onChange={(event) => setSuiteId(event.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elem)] px-3 py-2 text-sm"
            >
              {suites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name}
                </option>
              ))}
            </select>
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-sm text-[var(--status-error)]">
              {error}
            </p>
          ) : null}
          {paywall ? <div className="mt-3"><PaywallNotice info={paywall} /></div> : null}

          <div className="mt-4">
            <Button variant="accent" onClick={launch} disabled={launching}>
              {launching ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : browsers.length > 1 ? (
                <Play className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Lock className="h-4 w-4" aria-hidden="true" />
              )}
              {launching
                ? "Queueing matrix…"
                : `Run in ${browsers.length} browser${browsers.length === 1 ? "" : "s"}`}
            </Button>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              Quota policy: each browser execution counts as one test run.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
