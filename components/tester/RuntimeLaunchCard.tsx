"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, Loader2, Lock, Play, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { CreateSandboxResponse, SandboxInfo } from "@/types/runtime";
import type { ExtensionAnalysis } from "@/types/extension";

export interface RuntimeLaunchCardProps {
  analysis: ExtensionAnalysis;
  sourceFile: File | null;
}

export function RuntimeLaunchCard({
  analysis,
  sourceFile,
}: RuntimeLaunchCardProps) {
  const router = useRouter();
  const [testUrl, setTestUrl] = useState("https://example.com");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    if (!sourceFile) {
      setError("The original extension package is no longer available. Please re-upload it.");
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", sourceFile, sourceFile.name);
      form.append("testUrl", testUrl);
      const createResponse = await fetch("/api/sandbox/create", {
        method: "POST",
        body: form,
      });
      if (!createResponse.ok) {
        const body = (await createResponse.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? "The sandbox could not be created.");
        return;
      }
      const created = (await createResponse.json()) as CreateSandboxResponse;
      window.sessionStorage.setItem("extensionlab:sandbox-token", created.sessionToken);

      const startResponse = await fetch(`/api/sandbox/${created.sandboxId}/start`, {
        method: "POST",
        headers: { "x-sandbox-token": created.sessionToken },
      });
      if (!startResponse.ok) {
        const body = (await startResponse.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        await fetch(`/api/sandbox/${created.sandboxId}/stop`, {
          method: "POST",
          headers: { "x-sandbox-token": created.sessionToken },
        }).catch(() => undefined);
        window.sessionStorage.removeItem("extensionlab:sandbox-token");
        setError(body?.error?.message ?? "The isolated browser could not be started.");
        return;
      }
      const running = (await startResponse.json()) as SandboxInfo;
      router.push(`/dashboard/test?id=${encodeURIComponent(running.sandboxId)}`);
    } catch {
      setError("We could not reach the isolated sandbox backend. The runtime environment requires a Docker-capable server.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className="card card-pad">
      <div className="flex items-start gap-4">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
          <TerminalSquare className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Runtime testing</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">Launch isolated sandbox</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            {analysis.metadata.name ?? "Extension"} will be loaded into a fresh, disposable Chromium container. The package is only placed inside the sandbox. It is never installed in your normal browser.
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:flex sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="sandbox-test-url" className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <Globe className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
            Test URL
          </label>
          <input
            id="sandbox-test-url"
            type="url"
            value={testUrl}
            onChange={(event) => setTestUrl(event.target.value)}
            placeholder="https://example.com"
            className="min-h-[46px] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          />
          <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            Public HTTPS URLs only. Private and internal addresses are blocked.
          </p>
        </div>
        <Button variant="accent" onClick={() => void launch()} loading={launching} disabled={!sourceFile || launching} className="sm:mb-0">
          {launching ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Preparing sandbox
            </>
          ) : (
            <>
              <Play className="h-4 w-4" aria-hidden="true" />
              Launch Sandbox
            </>
          )}
        </Button>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-3 text-sm text-[var(--text-primary)]">
          {error}
        </div>
      ) : null}
    </section>
  );
}
