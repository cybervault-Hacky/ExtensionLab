"use client";

import type { NetworkEntry } from "@/types/runtime";
import { formatTime } from "./ConsolePanel";

export function NetworkPanel({ entries }: { entries: NetworkEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--text-secondary)]">
        No network activity captured yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--text-secondary)]">
            <th className="px-2 py-2 font-medium">Time</th>
            <th className="px-2 py-2 font-medium">Method</th>
            <th className="px-2 py-2 font-medium">URL</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Type</th>
            <th className="px-2 py-2 font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-[var(--border)] last:border-0">
              <td className="px-2 py-2 font-mono text-xs text-[var(--text-secondary)]">
                {formatTime(entry.timestamp)}
              </td>
              <td className="px-2 py-2 font-medium">{entry.method}</td>
              <td className="max-w-[360px] truncate px-2 py-2 font-mono text-xs text-[var(--text-primary)]" title={entry.url}>
                {entry.url}
              </td>
              <td className={entry.status && entry.status >= 400 ? "px-2 py-2 text-[var(--status-error)]" : "px-2 py-2 text-[var(--text-primary)]"}>
                {entry.status ?? "—"}
              </td>
              <td className="px-2 py-2 text-[var(--text-secondary)]">{entry.resourceType}</td>
              <td className="px-2 py-2 text-xs text-[var(--text-secondary)]">{entry.duration}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
