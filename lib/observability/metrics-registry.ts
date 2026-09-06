import "server-only";
import { onMetric } from "./logger";

/**
 * Lightweight in-process metrics registry (Phase 13 §52/§82).
 *
 * `recordMetric` fires subscriber hooks; this module subscribes once and keeps
 * bounded aggregates: counters by name+tag-set (capped) and small ring buffers
 * for latency-style metrics (names ending in `_latency` / `_duration`), from
 * which p50/p95/max snapshots are derived. Everything is bounded so a chatty
 * deployment can never grow the registry without limit.
 *
 * Scope: per process. In multi-replica deployments each instance reports its
 * own snapshot (documented in docs/OPERATIONS.md); the queue/session numbers
 * come from the database and are fleet-wide.
 */

const MAX_COUNTERS = 512;
const MAX_TAG_SETS_PER_COUNTER = 32;
const HISTOGRAM_RING = 512;
const MAX_HISTOGRAMS = 64;

export interface MetricCounterView {
  name: string;
  total: number;
  byTags: Array<{ tags: Record<string, string>; count: number }>;
}

export interface MetricHistogramView {
  name: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface MetricsSnapshot {
  generatedAt: number;
  counters: MetricCounterView[];
  histograms: MetricHistogramView[];
}

const counters = new Map<string, { total: number; byTags: Map<string, { tags: Record<string, string>; count: number }> }>();
const histograms = new Map<string, number[]>();
let hooked = false;

function ensureHook(): void {
  if (hooked) return;
  hooked = true;
  onMetric((name, value, tags) => {
    if (name.endsWith("_latency") || name.endsWith("_duration")) {
      if (histograms.size >= MAX_HISTOGRAMS && !histograms.has(name)) return;
      const ring = histograms.get(name) ?? [];
      ring.push(Math.max(0, Math.round(value)));
      if (ring.length > HISTOGRAM_RING) ring.splice(0, ring.length - HISTOGRAM_RING);
      histograms.set(name, ring);
      return;
    }
    if (counters.size >= MAX_COUNTERS && !counters.has(name)) return;
    const entry = counters.get(name) ?? { total: 0, byTags: new Map() };
    entry.total += 1;
    const tagKey = Object.keys(tags).length === 0 ? "" : JSON.stringify(tags);
    if (tagKey === "" || entry.byTags.size < MAX_TAG_SETS_PER_COUNTER || entry.byTags.has(tagKey)) {
      const tagged = entry.byTags.get(tagKey) ?? { tags, count: 0 };
      tagged.count += 1;
      entry.byTags.set(tagKey, tagged);
    }
    counters.set(name, entry);
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function metricsSnapshot(): MetricsSnapshot {
  ensureHook();
  const counterViews: MetricCounterView[] = [...counters.entries()]
    .map(([name, entry]) => ({
      name,
      total: entry.total,
      byTags: [...entry.byTags.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const histogramViews: MetricHistogramView[] = [...histograms.entries()].map(([name, ring]) => {
    const sorted = [...ring].sort((a, b) => a - b);
    return {
      name,
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    };
  });
  return { generatedAt: Date.now(), counters: counterViews, histograms: histogramViews };
}

/** Test-only reset. */
export function resetMetricsRegistryForTests(): void {
  counters.clear();
  histograms.clear();
}
