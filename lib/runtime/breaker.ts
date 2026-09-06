import "server-only";
import { recordMetric } from "@/lib/observability/logger";

/**
 * Deterministic circuit breaker for browser start failures (Phase 13 §26).
 *
 * Scope: one breaker per failure key (e.g. `interactive:chromium`), per worker
 * process. Workers are independent execution units; a failing browser image
 * opens the breaker on the workers that observe the failures, and healthy
 * workers keep serving — which is exactly the "prevent repeated failing jobs
 * from overwhelming infrastructure" requirement without a global choke point.
 *
 * States:
 *   HEALTHY   normal operation
 *   DEGRADED  failures observed but below the threshold (warning only)
 *   OPEN      threshold reached inside the window: starts fail fast with a
 *             retryable error until the cooldown elapses
 *   RECOVERY  cooldown elapsed: a bounded number of probe starts are allowed;
 *             a probe failure re-opens immediately, a success closes the breaker
 *
 * All transitions are deterministic functions of (failure timestamps, config);
 * there is no randomness and no timing guesswork.
 */

export type BreakerState = "HEALTHY" | "DEGRADED" | "OPEN" | "RECOVERY";

export interface BreakerDecision {
  allowed: boolean;
  state: BreakerState;
  /** Milliseconds until the breaker allows starts again (OPEN only). */
  retryAfterMs: number;
}

export interface BreakerSnapshot {
  key: string;
  state: BreakerState;
  failuresInWindow: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  probesAllowed: number;
}

interface BreakerInternals {
  failures: number[];
  openedAt: number | null;
  probeSuccesses: number;
}

const breakers = new Map<string, BreakerInternals>();

function breakerConfig() {
  return {
    failureThreshold: Math.max(1, numberFromEnv("BREAKER_FAILURE_THRESHOLD", 5)),
    windowMs: Math.max(10_000, numberFromEnv("BREAKER_WINDOW_MS", 120_000)),
    cooldownMs: Math.max(10_000, numberFromEnv("BREAKER_COOLDOWN_MS", 60_000)),
    recoveryProbes: Math.max(1, numberFromEnv("BREAKER_RECOVERY_PROBES", 2)),
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function internals(key: string): BreakerInternals {
  let entry = breakers.get(key);
  if (!entry) {
    entry = { failures: [], openedAt: null, probeSuccesses: 0 };
    breakers.set(key, entry);
  }
  return entry;
}

function prune(internals: BreakerInternals, now: number, windowMs: number): void {
  internals.failures = internals.failures.filter((at) => now - at < windowMs);
}

/** Whether a start attempt is allowed right now. */
export function breakerAllows(key: string, now = Date.now()): BreakerDecision {
  const { failureThreshold, windowMs, cooldownMs } = breakerConfig();
  const entry = internals(key);
  prune(entry, now, windowMs);
  if (entry.openedAt === null) {
    return { allowed: true, state: entry.failures.length > 0 ? "DEGRADED" : "HEALTHY", retryAfterMs: 0 };
  }
  if (now - entry.openedAt >= cooldownMs) {
    return { allowed: true, state: "RECOVERY", retryAfterMs: 0 };
  }
  return { allowed: false, state: "OPEN", retryAfterMs: entry.openedAt + cooldownMs - now };
}

/** Record a successful browser start (closes an open breaker after probes). */
export function recordBreakerSuccess(key: string, now = Date.now()): void {
  const { recoveryProbes, windowMs } = breakerConfig();
  const entry = internals(key);
  prune(entry, now, windowMs);
  if (entry.openedAt !== null) {
    entry.probeSuccesses += 1;
    if (entry.probeSuccesses >= recoveryProbes) {
      entry.openedAt = null;
      entry.probeSuccesses = 0;
      entry.failures = [];
      recordMetric("browser_breaker.closed", 1, { key });
    }
    return;
  }
  entry.failures = [];
}

/** Record a failed browser start (opens the breaker at the threshold). */
export function recordBreakerFailure(key: string, now = Date.now()): void {
  const { failureThreshold, windowMs } = breakerConfig();
  const entry = internals(key);
  prune(entry, now, windowMs);
  entry.failures.push(now);
  if (entry.openedAt !== null) {
    // A failure during RECOVERY re-opens immediately with a fresh cooldown.
    entry.openedAt = now;
    entry.probeSuccesses = 0;
    recordMetric("browser_breaker.reopened", 1, { key });
    return;
  }
  if (entry.failures.length >= failureThreshold) {
    entry.openedAt = now;
    entry.probeSuccesses = 0;
    recordMetric("browser_breaker.opened", 1, { key });
  }
}

export function breakerSnapshot(key: string, now = Date.now()): BreakerSnapshot {
  const { windowMs, recoveryProbes } = breakerConfig();
  const entry = internals(key);
  prune(entry, now, windowMs);
  const decision = breakerAllows(key, now);
  return {
    key,
    state: decision.state,
    failuresInWindow: entry.failures.length,
    lastFailureAt: entry.failures.length > 0 ? entry.failures[entry.failures.length - 1] : null,
    openedAt: entry.openedAt,
    probesAllowed: entry.openedAt === null ? 0 : recoveryProbes,
  };
}

/** All breaker states (admin view). Keys are internal; bounded. */
export function allBreakerSnapshots(now = Date.now()): BreakerSnapshot[] {
  return [...breakers.keys()].slice(0, 64).map((key) => breakerSnapshot(key, now));
}

/** Test-only reset. */
export function resetBreakersForTests(): void {
  breakers.clear();
}
