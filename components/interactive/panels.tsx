"use client";

import { useMemo, useState } from "react";
import { Camera, Paperclip, Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  classifySource,
  filterConsoleEntries,
  filterNetworkEntries,
  filterTimelineItems,
  occurredShortlyAfter,
  type ConsoleLevelFilter,
  type NetworkTypeFilter,
  type SeverityFilter,
  type TimelineItem,
} from "@/lib/interactive/panel-filters";
import type {
  ConsoleEntryView,
  InteractiveBrowserSessionView,
  InteractiveSessionEventView,
  NetworkEntryView,
  ScreenshotArtifactView,
  SessionEvidenceView,
} from "@/types/interactive";

/* eslint-disable @next/next/no-img-element */

/**
 * Phase 12 runtime panels. Every panel renders ONLY bounded server views,
 * filters locally through the pure helpers, and offers evidence actions that
 * reference real runtime records. Long lists render through a bounded window
 * ("Show more") so no unbounded array hits the DOM.
 */

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

const WINDOW_STEP = 60;

function useWindowed<T>(items: T[]) {
  const [limit, setLimit] = useState(WINDOW_STEP);
  return {
    visible: items.slice(0, limit),
    hidden: Math.max(0, items.length - limit),
    showMore: () => setLimit((current) => current + WINDOW_STEP * 2),
  };
}

function SearchInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-[140px] flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-secondary)]" aria-hidden="true" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-8 pr-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      />
    </div>
  );
}

function PillGroup<T extends string>({
  options,
  value,
  onChange,
  labels,
  ariaLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  labels: Record<string, string>;
  ariaLabel: string;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
            value === option
              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]",
          )}
        >
          {labels[option] ?? option}
        </button>
      ))}
    </div>
  );
}

function SaveEvidenceButton({ onSave, disabled }: { onSave: () => void; disabled?: boolean }) {
  const [saved, setSaved] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || saved}
      onClick={() => {
        onSave();
        setSaved(true);
        setTimeout(() => setSaved(false), 1600);
      }}
      className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--accent)] disabled:opacity-50"
      title="Mark this record as evidence"
    >
      {saved ? "Saved" : "Save"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export function ConsolePanel({
  entries,
  onSaveEvidence,
  onExplain,
}: {
  entries: ConsoleEntryView[];
  onSaveEvidence: (refId: string, detail: string, source: string) => void;
  onExplain: (entry: ConsoleEntryView) => void;
}) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<ConsoleLevelFilter>("all");
  const [clearedAt, setClearedAt] = useState(0);
  const filtered = useMemo(
    () => filterConsoleEntries(entries.filter((entry) => entry.timestamp > clearedAt), level, query),
    [entries, level, query, clearedAt],
  );
  const { visible, hidden, showMore } = useWindowed(filtered);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} label="Search console messages" placeholder="Search console" />
        <PillGroup
          options={["all", "logs", "info", "warnings", "errors"] as const}
          value={level}
          onChange={setLevel}
          labels={{ all: "All", logs: "Logs", info: "Info", warnings: "Warnings", errors: "Errors" }}
          ariaLabel="Console level filter"
        />
        <button
          type="button"
          onClick={() => setClearedAt(Date.now())}
          className="rounded-full px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)]"
        >
          Clear
        </button>
      </div>
      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-secondary)]">No console output matches.</p>
      ) : (
        <div role="log" aria-live="polite" className="space-y-0.5">
          {visible.map((entry) => (
            <div key={entry.id} className="group flex items-start gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-secondary)]">
              <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-secondary)]">{formatTime(entry.timestamp)}</span>
              <span
                className={cn(
                  "w-14 shrink-0 text-xs font-semibold uppercase",
                  entry.level === "error"
                    ? "text-[var(--status-error)]"
                    : entry.level === "warning"
                      ? "text-[var(--status-warning)]"
                      : entry.level === "info"
                        ? "text-[var(--status-info,var(--accent))]"
                        : "text-[var(--text-secondary)]",
                )}
              >
                {entry.level}
              </span>
              <span className="w-24 shrink-0 truncate text-xs text-[var(--text-secondary)]" title={`Source: ${entry.source}`}>
                {classifySource(entry.source)}
              </span>
              <span className="min-w-0 flex-1 break-words font-mono text-xs leading-relaxed">{entry.message}</span>
              <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                {(entry.level === "error" || entry.level === "warning") ? (
                  <button
                    type="button"
                    onClick={() => onExplain(entry)}
                    className="rounded-md px-1.5 py-0.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--accent)]"
                  >
                    Explain
                  </button>
                ) : null}
                <SaveEvidenceButton onSave={() => onSaveEvidence(entry.id, `[${entry.level}] ${entry.source}: ${entry.message}`, entry.source)} />
              </span>
            </div>
          ))}
          {hidden > 0 ? (
            <button type="button" onClick={showMore} className="mt-1 w-full rounded-lg py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--surface-secondary)]">
              Show {Math.min(hidden, WINDOW_STEP * 2)} more ({hidden} hidden)
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export function NetworkPanel({
  entries,
  onSaveEvidence,
}: {
  entries: NetworkEntryView[];
  onSaveEvidence: (refId: string, detail: string, url: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<NetworkTypeFilter>("all");
  const [selected, setSelected] = useState<NetworkEntryView | null>(null);
  const filtered = useMemo(() => filterNetworkEntries(entries, type, query), [entries, type, query]);
  const { visible, hidden, showMore } = useWindowed(filtered);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} label="Search network requests" placeholder="Search URL or method" />
        <PillGroup
          options={["all", "fetch", "xhr", "document", "script", "image", "stylesheet", "other"] as const}
          value={type}
          onChange={setType}
          labels={{ all: "All", stylesheet: "CSS", other: "Other" }}
          ariaLabel="Network resource type filter"
        />
      </div>
      {selected ? (
        <div className="rounded-xl border border-[var(--border)] p-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 break-all font-mono text-xs">{selected.url}</p>
            <button type="button" onClick={() => setSelected(null)} className="shrink-0 text-xs text-[var(--accent)]">
              Close
            </button>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            <div><dt className="text-[var(--text-secondary)]">Method</dt><dd className="font-mono">{selected.method}</dd></div>
            <div><dt className="text-[var(--text-secondary)]">Status</dt><dd className="font-mono">{selected.status ?? "—"}</dd></div>
            <div><dt className="text-[var(--text-secondary)]">Type</dt><dd className="font-mono">{selected.resourceType}</dd></div>
            <div><dt className="text-[var(--text-secondary)]">Duration</dt><dd className="font-mono">{selected.duration} ms</dd></div>
            <div><dt className="text-[var(--text-secondary)]">Time</dt><dd className="font-mono">{formatTime(selected.timestamp)}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Request and response headers are never captured.</p>
        </div>
      ) : null}
      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-secondary)]">No network requests match.</p>
      ) : (
        <div className="space-y-0.5">
          <div className="hidden grid-cols-[64px_minmax(0,1fr)_48px_72px_64px_64px_52px] gap-2 px-2 pb-1 text-xs font-medium text-[var(--text-secondary)] sm:grid" aria-hidden="true">
            <span>Method</span><span>URL</span><span>Status</span><span>Type</span><span className="text-right">Duration</span><span className="text-right">Time</span><span />
          </div>
          {visible.map((entry) => (
            <div key={entry.id} className="group grid grid-cols-[64px_minmax(0,1fr)_48px] items-center gap-2 rounded-lg px-2 py-1 font-mono text-xs hover:bg-[var(--surface-secondary)] sm:grid-cols-[64px_minmax(0,1fr)_48px_72px_64px_64px_52px]">
              <span className="font-semibold">{entry.method}</span>
              <button type="button" onClick={() => setSelected(entry)} className="min-w-0 truncate text-left hover:text-[var(--accent)]" title={entry.url}>
                {entry.url}
              </button>
              <span className={cn("text-right sm:text-left", entry.status !== null && entry.status >= 400 ? "text-[var(--status-error)]" : entry.status !== null && entry.status >= 300 ? "text-[var(--status-warning)]" : "")}>
                {entry.status ?? "—"}
              </span>
              <span className="hidden text-[var(--text-secondary)] sm:block">{entry.resourceType}</span>
              <span className="hidden text-right text-[var(--text-secondary)] sm:block">{entry.duration} ms</span>
              <span className="hidden text-right text-[var(--text-secondary)] sm:block">{formatTime(entry.timestamp)}</span>
              <span className="hidden justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 sm:flex">
                <SaveEvidenceButton onSave={() => onSaveEvidence(entry.id, `${entry.method} ${entry.url} → ${entry.status ?? "pending"}`, entry.url)} />
              </span>
            </div>
          ))}
          {hidden > 0 ? (
            <button type="button" onClick={showMore} className="mt-1 w-full rounded-lg py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--surface-secondary)]">
              Show {Math.min(hidden, WINDOW_STEP * 2)} more ({hidden} hidden)
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extension runtime panel
// ---------------------------------------------------------------------------

function categorizePermissions(session: InteractiveBrowserSessionView) {
  const browser = session.extension.permissions;
  const hosts = session.extension.hostPermissions;
  const sensitive = browser.filter((permission) =>
    ["debugger", "proxy", "webRequest", "webRequestBlocking", "nativeMessaging", "downloads", "privacy", "management", "cookies", "browsingData"].includes(permission),
  );
  const broad = hosts.filter((host) => host === "<all_urls>" || host === "*://*/*" || host === "http://*/*" || host === "https://*/*");
  return { browser, hosts, sensitive, broad };
}

export function ExtensionPanel({
  session,
  onReload,
  busy,
}: {
  session: InteractiveBrowserSessionView;
  onReload: () => void;
  busy: boolean;
}) {
  const { browser, hosts, sensitive, broad } = categorizePermissions(session);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-label="Extension overview">
        <h3 className="text-sm font-semibold">Overview</h3>
        <dl className="mt-2 space-y-1.5 text-sm">
          <Row label="Name" value={session.extension.name ?? "Unknown"} />
          <Row label="Version" value={session.extension.version ?? "—"} mono />
          <Row label="Manifest" value={session.extension.manifestVersion ?? "—"} mono />
          <Row label="Package SHA-256" value={`${session.packageSha256.slice(0, 16)}…`} mono />
          <Row label="Runtime status" value={session.extensionRuntimeStatus} mono />
          <Row label="Popup" value={session.extension.popupPath ? `Available (${session.extension.popupPath})` : "None declared"} />
          <Row label="Service worker" value={session.extension.hasServiceWorker ? "Declared" : "Not declared"} />
          <Row label="Content scripts" value={session.extension.hasContentScripts ? `Declared (${session.extension.contentScriptMatches.length} match pattern(s))` : "Not declared"} />
        </dl>
      </section>
      <section aria-label="Permissions">
        <h3 className="text-sm font-semibold">Permissions</h3>
        <div className="mt-2 space-y-3 text-sm">
          <PermissionChips title="Browser permissions" items={browser} empty="None" />
          <PermissionChips title="Host permissions" items={hosts} empty="None" />
          {broad.length > 0 ? (
            <p className="rounded-lg border border-[var(--status-warning)]/40 bg-[var(--surface-secondary)] px-3 py-2 text-xs">
              Broad host access — this extension can read and change data on all sites it runs on. Review recommended.
            </p>
          ) : null}
          {sensitive.length > 0 ? (
            <p className="rounded-lg border border-[var(--status-warning)]/40 bg-[var(--surface-secondary)] px-3 py-2 text-xs">
              Potentially sensitive capability: {sensitive.join(", ")}. Review recommended.
            </p>
          ) : null}
          <button
            type="button"
            onClick={onReload}
            disabled={busy}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-secondary)] disabled:opacity-50"
          >
            {busy ? "Reloading…" : "Reload extension"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right", mono && "font-mono text-xs")} title={value}>{value}</dd>
    </div>
  );
}

function PermissionChips({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-[var(--text-secondary)]">{title}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.length === 0 ? (
          <span className="text-xs text-[var(--text-secondary)]">{empty}</span>
        ) : (
          items.map((item) => (
            <span key={item} className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 font-mono text-xs">{item}</span>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified timeline
// ---------------------------------------------------------------------------

export function buildTimeline(
  events: InteractiveSessionEventView[],
  consoleEntries: ConsoleEntryView[],
  networkEntries: NetworkEntryView[],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    items.push({
      id: `s-${event.seq}`,
      timestamp: event.timestamp,
      kind: "session",
      severity: event.level,
      source: "session",
      message: event.message,
    });
  }
  for (const entry of consoleEntries) {
    items.push({
      id: `c-${entry.id}`,
      timestamp: entry.timestamp,
      kind: "console",
      severity: entry.level === "warning" || entry.level === "error" ? entry.level : "info",
      source: classifySource(entry.source),
      message: entry.message,
    });
  }
  for (const entry of networkEntries) {
    items.push({
      id: `n-${entry.id}`,
      timestamp: entry.timestamp,
      kind: "network",
      severity: entry.status !== null && entry.status >= 400 ? "warning" : "info",
      source: "network",
      message: `${entry.method} ${entry.url} → ${entry.status ?? "pending"}`,
    });
  }
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

export function TimelinePanel({
  events,
  consoleEntries,
  networkEntries,
  onSaveEvidence,
}: {
  events: InteractiveSessionEventView[];
  consoleEntries: ConsoleEntryView[];
  networkEntries: NetworkEntryView[];
  onSaveEvidence: (refId: string, detail: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [source, setSource] = useState("all");
  const items = useMemo(() => buildTimeline(events, consoleEntries, networkEntries), [events, consoleEntries, networkEntries]);
  const filtered = useMemo(() => filterTimelineItems(items, severity, source, query), [items, severity, source, query]);
  const { visible, hidden, showMore } = useWindowed(filtered);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} label="Search timeline" placeholder="Search events" />
        <PillGroup
          options={["all", "info", "warning", "error"] as const}
          value={severity}
          onChange={setSeverity}
          labels={{ all: "All", info: "Info", warning: "Warnings", error: "Errors" }}
          ariaLabel="Timeline severity filter"
        />
        <label className="sr-only" htmlFor="timeline-source">Timeline source filter</label>
        <select
          id="timeline-source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs outline-none"
        >
          <option value="all">All sources</option>
          <option value="session">Session</option>
          <option value="extension">Extension</option>
          <option value="content-script">Content script</option>
          <option value="service-worker">Service worker</option>
          <option value="popup">Popup</option>
          <option value="page">Page</option>
          <option value="network">Network</option>
        </select>
      </div>
      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-secondary)]">No timeline entries match.</p>
      ) : (
        <ol className="space-y-0.5" aria-label="Runtime event timeline">
          {visible.map((item, index) => {
            const previous = index > 0 ? visible[index - 1] : null;
            const correlated = previous ? occurredShortlyAfter(item, previous) : false;
            return (
              <li key={item.id} className="group flex items-start gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-secondary)]">
                <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-secondary)]">{formatTime(item.timestamp)}</span>
                <span
                  className={cn(
                    "w-16 shrink-0 text-xs font-semibold capitalize",
                    item.severity === "error" ? "text-[var(--status-error)]" : item.severity === "warning" ? "text-[var(--status-warning)]" : "text-[var(--text-secondary)]",
                  )}
                >
                  {item.kind}
                </span>
                <span className="w-24 shrink-0 truncate text-xs text-[var(--text-secondary)]" title={`Source: ${item.source}`}>{item.source}</span>
                <span className="min-w-0 flex-1 break-words text-xs leading-relaxed">{item.message}</span>
                {correlated ? (
                  <span className="hidden shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-secondary)] sm:inline" title="Temporal proximity only — not causation">
                    occurred after previous
                  </span>
                ) : null}
                <span className="hidden shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 sm:block">
                  <SaveEvidenceButton onSave={() => onSaveEvidence(item.id, `${formatTime(item.timestamp)} [${item.kind}/${item.source}] ${item.message}`)} />
                </span>
              </li>
            );
          })}
          {hidden > 0 ? (
            <button type="button" onClick={showMore} className="mt-1 w-full rounded-lg py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--surface-secondary)]">
              Show {Math.min(hidden, WINDOW_STEP * 2)} more ({hidden} hidden)
            </button>
          ) : null}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screenshots gallery
// ---------------------------------------------------------------------------

export function ScreenshotsPanel({
  artifacts,
  sessionId,
  onCapture,
  onAttach,
  evidenceByArtifact,
  onDeleteEvidence,
  busy,
}: {
  artifacts: ScreenshotArtifactView[];
  sessionId: string;
  onCapture: () => void;
  onAttach: (artifactId: string) => void;
  /** artifact id -> saved evidence id (only saved screenshots can be removed). */
  evidenceByArtifact: Record<string, string>;
  onDeleteEvidence: (artifactId: string) => void;
  busy: boolean;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-secondary)]">
          Screenshots record timestamp, session, package version + SHA-256 and browser version, and follow artifact retention.
        </p>
        <button
          type="button"
          onClick={onCapture}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-secondary)] disabled:opacity-50"
        >
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          Capture screenshot
        </button>
      </div>
      {artifacts.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-secondary)]">No screenshots captured yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {artifacts.map((artifact) => (
              <figure key={artifact.id} className="overflow-hidden rounded-xl border border-[var(--border)]">
                <a href={artifact.url} target="_blank" rel="noreferrer" aria-label={`Open screenshot captured ${new Date(artifact.createdAt).toLocaleString()}`}>
                  <img src={`${artifact.url}`} alt={`Screenshot captured ${new Date(artifact.createdAt).toLocaleString()}`} className="aspect-video w-full bg-[var(--surface-secondary)] object-cover" />
                </a>
                <figcaption className="space-y-1 p-2 text-xs">
                  <p className="font-mono text-[var(--text-secondary)]">{formatTime(artifact.createdAt)} · {(artifact.size / 1024).toFixed(0)} KB</p>
                  {artifact.label ? <p className="truncate">{artifact.label}</p> : null}
                  <div className="flex items-center gap-2 pt-0.5">
                    {evidenceByArtifact[artifact.id] ? (
                      <>
                        <span className="inline-flex items-center gap-1 font-medium text-[var(--status-success)]">
                          <Paperclip className="h-3 w-3" aria-hidden="true" />
                          In evidence
                        </span>
                        <button
                          type="button"
                          onClick={() => onDeleteEvidence(artifact.id)}
                          className="ml-auto inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--status-error)]"
                          aria-label={`Remove screenshot evidence for ${artifact.id}`}
                          title="Remove from evidence (artifacts follow session retention)"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => onAttach(artifact.id)} className="font-medium text-[var(--accent)] hover:underline">
                        Save to report
                      </button>
                    )}
                  </div>
                </figcaption>
              </figure>
            ))}
        </div>
      )}
      <p className="sr-only">Session {sessionId} screenshot gallery.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence list
// ---------------------------------------------------------------------------

export function EvidencePanel({
  evidence,
  onAttach,
  onDelete,
}: {
  evidence: SessionEvidenceView[];
  onAttach: (evidenceId: string) => void;
  onDelete: (evidenceId: string) => void;
}) {
  if (evidence.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--text-secondary)]">
        No evidence saved yet. Use the Save actions in Console, Network, Timeline and Screenshots.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {evidence.map((item) => (
        <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="flex items-center gap-2">
              <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-xs font-medium capitalize">{item.kind}</span>
              {item.label ? <span className="truncate font-medium">{item.label}</span> : null}
            </p>
            <p className="mt-1 break-words text-xs text-[var(--text-secondary)]">{item.summary}</p>
            <p className="mt-1 font-mono text-xs text-[var(--text-secondary)]">
              {formatTime(item.createdAt)} · {item.browser} {item.browserVersion ?? ""} · {item.packageSha256.slice(0, 10)}…
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {item.reportId ? (
              <span className="rounded-full bg-[var(--status-success)]/10 px-2 py-1 font-medium text-[var(--status-success)]">In report</span>
            ) : (
              <>
                <button type="button" onClick={() => onAttach(item.id)} className="font-medium text-[var(--accent)] hover:underline">
                  Save to report
                </button>
                <button type="button" onClick={() => onDelete(item.id)} className="text-[var(--text-secondary)] hover:text-[var(--status-error)]">
                  Delete
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
