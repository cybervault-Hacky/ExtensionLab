import "server-only";
import { getConfig } from "@/lib/config/env";
import { checkRateLimit, type RateLimitResult } from "./rate-limit";
import { logger } from "@/lib/observability/logger";

export type RateLimitedAction = keyof ReturnType<typeof getConfig>["rateLimits"];

const WINDOW_MS = 60 * 1000;

/**
 * Central rate-limit policy (per action, per client key, one-minute window).
 * Limits are configurable through RATE_LIMIT_* environment variables so
 * operators can tune them without code changes. The store is in-memory per
 * process; run a single web replica or a sticky proxy limit in front of it
 * (see docs/OPERATIONS.md).
 */
export function enforceRateLimit(action: RateLimitedAction, clientKey: string): RateLimitResult {
  const limit = getConfig().rateLimits[action];
  return checkRateLimit(`${action}:${clientKey}`, limit, WINDOW_MS);
}

/**
 * Phase 13 §58: distributed rate limiting. Uses the shared coordination store
 * (Redis in multi-replica deployments, in-memory otherwise) so limits hold
 * across every web instance. If the shared store fails, the request is NOT
 * rejected outright: the per-process limit still applies (degraded, logged)
 * so availability survives a Redis blip without removing all protection.
 */
export async function enforceRateLimitAsync(action: RateLimitedAction, clientKey: string): Promise<RateLimitResult> {
  const limit = getConfig().rateLimits[action];
  try {
    const { getCoordinationStore } = await import("@/lib/coordination");
    const store = await getCoordinationStore();
    const result = await store.rateLimit(`${action}:${clientKey}`, limit, WINDOW_MS);
    return { ok: result.ok, remaining: result.remaining, retryAfterSeconds: result.retryAfterSeconds };
  } catch (error) {
    logger.warn("ratelimit.store_unavailable", { component: "auth", action, detail: error instanceof Error ? error.name : "unknown" });
    return enforceRateLimit(action, clientKey);
  }
}
