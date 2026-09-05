"use client";

import type { RuntimeEvent } from "@/types/runtime";
import { cn } from "@/lib/utils";

const levelClass: Record<string, string> = {
  error: "text-[var(--status-error)]",
  warning: "text-[var(--status-warning)]",
  info: "text-[var(--accent)]",
  log: "text-[var(--text-primary)]",
  debug: "text-[var(--text-secondary)]",
};

export function ConsolePanel({ events }: { events: RuntimeEvent[] }) {
  const logs = events.filter(
    (event) =>
      event.type === "console" ||
      event.type === "error" ||
      (event.type === "browser" && event.level === "error"),
  );

  if (logs.length === 0) {
    return <EmptyPanel label="No console output yet." />;
  }

  return (
    <div role="log" aria-live="polite" className="space-y-1">
      {logs.map((event) => (
        <div
          key={event.id}
          className="flex gap-3 rounded-lg px-3 py-2 text-sm hover:bg-[var(--surface-secondary)]"
        >
          <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-secondary)]">
            {formatTime(event.timestamp)}
          </span>
          <span
            className={cn(
              "w-16 shrink-0 text-xs font-semibold uppercase",
              levelClass[event.level] ?? "text-[var(--text-secondary)]",
            )}
          >
            {event.level === "warning" ? "WARN" : event.level}
          </span>
          <span className="min-w-0 flex-1 break-words text-[var(--text-primary)]">
            {event.message}
          </span>
          <span className="shrink-0 text-xs text-[var(--text-secondary)]">
            {event.source}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return (
    <p className="py-8 text-center text-sm text-[var(--text-secondary)]">
      {label}
    </p>
  );
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
