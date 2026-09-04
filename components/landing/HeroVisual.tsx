"use client";

import { Check, FileArchive, TriangleAlert } from "lucide-react";

const rows = [
  { label: "Manifest", status: "passed" as const },
  { label: "Structure", status: "passed" as const },
  { label: "Permissions", status: "warning" as const },
  { label: "Configuration", status: "passed" as const },
];

export function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-md">
      <div className="card card-pad overflow-hidden p-6">
        <div className="flex items-center gap-2 border-b border-[var(--border)] pb-4">
          <span className="inline-flex h-3 w-3 rounded-full bg-[var(--surface-secondary)]" />
          <span className="inline-flex h-3 w-3 rounded-full bg-[var(--surface-secondary)]" />
          <span className="inline-flex h-3 w-3 rounded-full bg-[var(--surface-secondary)]" />
          <span className="ml-2 text-xs font-semibold text-[var(--text-secondary)]">
            ExtensionLab Analyzer
          </span>
        </div>

        <div className="mt-5 flex items-center gap-4">
          <div className="relative inline-flex h-20 w-20 shrink-0 items-center justify-center">
            <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true">
              <circle cx="50" cy="50" r="42" fill="none" stroke="var(--surface-secondary)" strokeWidth="9" />
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray="252 264"
              />
            </svg>
            <div className="absolute text-center">
              <div className="text-2xl font-semibold tabular-nums">92</div>
              <div className="text-[10px] text-[var(--text-secondary)]">/ 100</div>
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold">Extension Health</p>
            <p className="text-xs text-[var(--text-secondary)]">
              Local file inspection
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between rounded-xl bg-[var(--surface-secondary)] px-3 py-2.5"
            >
              <span className="text-sm font-medium">{row.label}</span>
              {row.status === "passed" ? (
                <Check className="h-4 w-4 text-[var(--status-success)]" aria-label="Passed" />
              ) : (
                <TriangleAlert className="h-4 w-4 text-[var(--status-warning)]" aria-label="Review" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card absolute -bottom-4 -right-2 flex items-center gap-3 px-4 py-3 shadow-lifted sm:-right-8">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
          <FileArchive className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold">extension.zip</p>
          <p className="text-xs text-[var(--text-secondary)]">Analyzed locally</p>
        </div>
      </div>
    </div>
  );
}
