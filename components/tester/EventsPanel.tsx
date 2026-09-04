"use client";

import type { RuntimeEvent } from "@/types/runtime";
import { cn } from "@/lib/utils";

const colorByLevel: Record<string, string> = {
  error: "text-[var(--status-error)]",
  warning: "text-[var(--status-warning)]",
  info: "text-[var(--accent)]",
  log: "text-[var(--text-primary)]",
  debug: "text-[var(--text-secondary)]",
};

export function EventsPanel({ events }: { events: RuntimeEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--text-secondary)]">
        Runtime events will appear here as the sandbox runs.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {events.map((event) => (
        <div key={event.id} className="flex gap-3 rounded-lg px-3 py-2 text-sm hover:bg-[var(--surface-secondary)]">
          <span className="shrink-0 text-xs text-[var(--text-secondary)]">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
          <span className="w-20 shrink-0 text-xs font-semibold uppercase text-[var(--text-secondary)]">
            {event.type}
          </span>
          <span className={cn("w-16 shrink-0 text-xs font-semibold", colorByLevel[event.level] ?? "text-[var(--text-secondary)]")}>
            {event.level === "warning" ? "WARN" : event.level}
          </span>
          <span className="min-w-0 flex-1 break-words">{event.message}</span>
        </div>
      ))}
    </div>
  );
}
