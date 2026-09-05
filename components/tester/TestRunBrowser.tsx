"use client";

import { useEffect, useState } from "react";
import { AutomatedTestRunView } from "./AutomatedTestRunView";
import { PersistentTestRunView } from "./PersistentTestRunView";

const LIVE_STATES = new Set([
  "idle",
  "preparing",
  "starting",
  "running",
  "stopping",
]);

export function TestRunBrowser({ runId }: { runId: string }) {
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const token = window.sessionStorage.getItem(`extensionlab:test-token:${runId}`);

    async function resolve() {
      let persisted: { status?: string } | null = null;
      const response = await fetch(`/api/tests/${runId}`).catch(() => null);
      if (response?.ok) {
        const body = (await response.json()) as { run?: { status?: string } };
        persisted = body.run ?? null;
      }

      if (cancelled) return;
      if (token && persisted && LIVE_STATES.has(persisted.status ?? "")) {
        setLive(true);
        return;
      }
      // Either there is no live token, the run is terminal (including a stale
      // token after a server restart), or the persisted run is the source of
      // truth. Fall back to the persistent report view.
      if (token && persisted && !LIVE_STATES.has(persisted.status ?? "")) {
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

  return live ? <AutomatedTestRunView runId={runId} /> : <PersistentTestRunView runId={runId} />;
}
