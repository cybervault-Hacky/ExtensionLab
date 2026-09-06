import "server-only";

/**
 * Controlled browser resource profiles (Phase 13 §12).
 *
 * Users NEVER choose raw infrastructure limits. The server maps the caller's
 * plan entitlement to one of a fixed set of profiles; every value is capped by
 * the deployment configuration, and the profile only tightens (never loosens)
 * the container hardening baseline.
 */

export type ResourceProfileId = "standard" | "heavy";

export interface ResourceProfile {
  id: ResourceProfileId;
  /** Container memory limit (Docker -m syntax). */
  memoryLimit: string;
  /** Container CPU limit (Docker --cpus syntax). */
  cpuLimit: string;
  /** Container PID limit. */
  pidsLimit: number;
  /** /dev/shm size for the browser process. */
  shmSize: string;
  /** Upper bound for a single browser start (ms). */
  startTimeoutMs: number;
  /** Upper bound for a whole session/run (ms). */
  maxRuntimeMs: number;
  /** Screenshot captures per minute per session. */
  screenshotsPerMinute: number;
  /** Bounded runtime event buffer (ring) size. */
  eventBufferSize: number;
}

export const RESOURCE_PROFILES: Readonly<Record<ResourceProfileId, ResourceProfile>> = {
  standard: {
    id: "standard",
    memoryLimit: "768m",
    cpuLimit: "0.5",
    pidsLimit: 200,
    shmSize: "256m",
    startTimeoutMs: 90_000,
    maxRuntimeMs: 20 * 60_000,
    screenshotsPerMinute: 10,
    eventBufferSize: 300,
  },
  heavy: {
    id: "heavy",
    memoryLimit: "1536m",
    cpuLimit: "1.0",
    pidsLimit: 400,
    shmSize: "512m",
    startTimeoutMs: 150_000,
    maxRuntimeMs: 45 * 60_000,
    screenshotsPerMinute: 20,
    eventBufferSize: 600,
  },
};

export function isResourceProfileId(value: unknown): value is ResourceProfileId {
  return value === "standard" || value === "heavy";
}

/**
 * Resolve the profile for a caller. Only entitlement logic may request `heavy`
 * (e.g. a paid plan flag); anything unknown maps to `standard` — a failed or
 * missing lookup must never widen resource usage.
 */
export function resolveResourceProfile(input: { requested?: unknown; allowHeavy?: boolean }): ResourceProfile {
  const requested = isResourceProfileId(input.requested) ? input.requested : "standard";
  if (requested === "heavy" && !input.allowHeavy) return RESOURCE_PROFILES.standard;
  return RESOURCE_PROFILES[requested];
}

/** Parse a Docker memory limit ("768m", "1g", "1536m") to bytes. */
export function memoryLimitToBytes(limit: string): number {
  const match = /^(\d+)(k|m|g)?$/i.exec(limit.trim());
  if (!match) return 0;
  const size = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : unit === "g" ? 1024 ** 3 : 1;
  return size * multiplier;
}
