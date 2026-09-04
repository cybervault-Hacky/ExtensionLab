/* eslint-disable @next/next/no-img-element */
"use client";

import { ArrowLeft, ArrowRight, Lock, RefreshCw } from "lucide-react";

export interface BrowserViewportProps {
  screenshotUrl: string | null;
  status: string;
  testUrl: string;
  onRefresh: () => void;
}

export function BrowserViewport({
  screenshotUrl,
  status,
  testUrl,
  onRefresh,
}: BrowserViewportProps) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)]">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)]">
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </span>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh isolated browser view"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
          <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
          <span className="truncate font-mono text-xs text-[var(--text-secondary)]">
            {testUrl}
          </span>
        </div>
      </div>

      <div className="relative flex min-h-[380px] items-center justify-center bg-[var(--bg)] sm:min-h-[460px]">
        {screenshotUrl ? (
          // The screenshot is rendered as an image; it is never parsed or
          // injected as HTML. Only the sandbox runner can produce it.
          <img
            src={screenshotUrl}
            alt={`Isolated browser showing ${testUrl}`}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="px-6 text-center">
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              Isolated browser view
            </p>
            <p className="mt-2 max-w-sm text-sm text-[var(--text-secondary)]">
              {status === "Running" || status === "Sandbox ready"
                ? "Waiting for the first browser frame from the sandbox."
                : "A live browser frame will appear once the sandbox is running."}
            </p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              The page runs only inside the disposable container.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
