"use client";

import { useEffect, useState } from "react";
import { AutomatedTestRunView } from "./AutomatedTestRunView";
import { PersistentTestRunView } from "./PersistentTestRunView";
import { isActiveRunStatus } from "@/lib/testing/status-labels";

/**
 * Chooses between the live view (queued/running) and the persisted report
 * (terminal). Phase 6 stores every run in the database, so a page refresh,
 * a new tab or a web restart never loses a run: access is based on session
 * ownership; the legacy per-run token is only kept for Phase 4 clients.
 */
export function TestRunBrowser({ runId }: { runId: string }) {
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      const response = await fetch(`/api/tests/${runId}`, { cache: "no-store" }).catch(() => null);
      if (cancelled) return;
      if (response?.ok) {
        const body = (await response.json()) as { run?: { status?: string } };
        if (isActiveRunStatus(body.run?.status)) {
          setLive(true);
          return;
        }
        window.sessionStorage.removeItem(`extensionlab:test-token:${runId}`);
      }
      setLive(false);
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (live === null) {
    return (
      <div className="space-y-4">
        <div className="card h-40 animate-pulse" />
        <div className="card h-32 animate-pulse" />
      </div>
    );
  }

  return live ? <AutomatedTestRunView runId={runId} onFinished={() => setLive(false)} /> : <PersistentTestRunView runId={runId} />;
}
