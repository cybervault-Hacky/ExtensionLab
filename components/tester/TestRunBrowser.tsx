"use client";

import { useEffect, useState } from "react";
import { AutomatedTestRunView } from "./AutomatedTestRunView";
import { PersistentTestRunView } from "./PersistentTestRunView";

export function TestRunBrowser({ runId }: { runId: string }) {
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    const token = window.sessionStorage.getItem(`extensionlab:test-token:${runId}`);
    setLive(Boolean(token));
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
