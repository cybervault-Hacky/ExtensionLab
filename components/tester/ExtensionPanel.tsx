"use client";

import type { RuntimeEvent, SandboxInfo } from "@/types/runtime";

function statusDot(state: string): string {
  if (state === "loaded" || state === "active" || state === "running") return "var(--status-success)";
  if (state === "failed" || state === "unavailable") return "var(--status-error)";
  if (state === "detected" || state === "idle" || state === "loading") return "var(--status-warning)";
  return "var(--text-secondary)";
}

export function ExtensionPanel({
  info,
  events,
}: {
  info: SandboxInfo | null;
  events: RuntimeEvent[];
}) {
  const extension = info?.extension;
  const extensionEvents = events.filter((event) => event.type === "extension");

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatusCard label="Extension" state={extension?.extensionState ?? "detected"} detail={extension?.message ?? "Unpacked extension"} />
        <StatusCard label="Service Worker" state={extension?.serviceWorkerState ?? "detected"} detail={extension?.serviceWorkerFile ?? "Momentary state"} />
        <StatusCard label="Content Scripts" state={extension?.contentScriptsState ?? "detected"} detail="Observed via manifest / runtime events" />
        <StatusCard label="Popup" state={extension?.popupState ?? "detected"} detail={extension?.popupPath ?? "Action-defined extension"} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Extension lifecycle</h3>
        {extensionEvents.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">
            No extension lifecycle events captured yet.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {extensionEvents.map((event) => (
              <li key={event.id} className="flex gap-3 rounded-lg px-2 py-1.5">
                <span className="font-mono text-xs text-[var(--text-secondary)]">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
                <span className="min-w-0 flex-1 break-words">{event.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  label,
  state,
  detail,
}: {
  label: string;
  state: string;
  detail?: string;
}) {
  const stateLabel = state.charAt(0).toUpperCase() + state.slice(1);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {label}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <span className="inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: statusDot(state) }} aria-hidden="true" />
        <span className="text-sm font-semibold">{stateLabel}</span>
      </div>
      {detail ? <p className="mt-1 text-xs text-[var(--text-secondary)]">{detail}</p> : null}
    </div>
  );
}
