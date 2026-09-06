/**
 * Phase 12 panel filter/search helpers (pure, shared by the workspace panels
 * and tests). All inputs are already the bounded views the server produces;
 * filtering never grows buffers.
 */

import type { ConsoleEntryView, NetworkEntryView } from "@/types/interactive";

export type ConsoleLevelFilter = "all" | "logs" | "info" | "warnings" | "errors";

export function filterConsoleEntries(
  entries: readonly ConsoleEntryView[],
  level: ConsoleLevelFilter,
  query: string,
): ConsoleEntryView[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (level === "logs" && entry.level !== "log") return false;
    if (level === "info" && entry.level !== "info") return false;
    if (level === "warnings" && entry.level !== "warning") return false;
    if (level === "errors" && entry.level !== "error") return false;
    if (needle && !entry.message.toLowerCase().includes(needle) && !entry.source.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
}

/**
 * Safe source classification. The runner reports a bounded source string; we
 * map it onto the five safe categories and never invent finer detail (e.g. no
 * host filesystem paths) when the evidence is missing.
 */
export type SafeSource = "extension" | "content-script" | "service-worker" | "popup" | "page" | "browser" | "other";

export function classifySource(source: string): SafeSource {
  const value = source.toLowerCase();
  if (value === "popup") return "popup";
  if (value === "content-script" || value === "content script") return "content-script";
  if (value === "service-worker" || value === "service worker" || value === "background") return "service-worker";
  if (value === "extension" || value.startsWith("chrome-extension")) return "extension";
  if (value === "page" || value === "log") return "page";
  if (value === "browser" || value === "sandbox" || value === "runner" || value === "network" || value === "session-hub") {
    return "browser";
  }
  return "other";
}

export type NetworkTypeFilter = "all" | "fetch" | "xhr" | "document" | "script" | "image" | "stylesheet" | "other";

function normalizeResourceType(resourceType: string): NetworkTypeFilter {
  const value = resourceType.toLowerCase();
  if (value === "fetch") return "fetch";
  if (value === "xhr") return "xhr";
  if (value === "document") return "document";
  if (value === "script") return "script";
  if (value === "image" || value === "img") return "image";
  if (value === "stylesheet" || value === "css") return "stylesheet";
  return "other";
}

export function filterNetworkEntries(
  entries: readonly NetworkEntryView[],
  type: NetworkTypeFilter,
  query: string,
): NetworkEntryView[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (type !== "all" && normalizeResourceType(entry.resourceType) !== type) return false;
    if (needle && !entry.url.toLowerCase().includes(needle) && !entry.method.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** Unified timeline item projected from the bounded server-side rings. */
export interface TimelineItem {
  id: string;
  timestamp: number;
  kind: "session" | "console" | "network";
  severity: "info" | "warning" | "error";
  source: string;
  message: string;
}

export type SeverityFilter = "all" | "info" | "warning" | "error";

export function filterTimelineItems(
  items: readonly TimelineItem[],
  severity: SeverityFilter,
  sourceFilter: string,
  query: string,
): TimelineItem[] {
  const needle = query.trim().toLowerCase();
  const source = sourceFilter === "all" ? "" : sourceFilter.toLowerCase();
  return items.filter((item) => {
    if (severity !== "all" && item.severity !== severity) return false;
    if (source && item.source.toLowerCase() !== source) return false;
    if (needle && !item.message.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * Correlation hint between two timeline items. This NEVER claims causation —
 * only temporal proximity, with honest wording chosen by the caller.
 */
export const CORRELATION_WINDOW_MS = 5000;

export function occurredShortlyAfter(candidate: TimelineItem, previous: TimelineItem): boolean {
  const delta = candidate.timestamp - previous.timestamp;
  return delta > 0 && delta <= CORRELATION_WINDOW_MS;
}
