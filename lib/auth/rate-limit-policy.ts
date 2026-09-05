import "server-only";
import { getConfig } from "@/lib/config/env";
import { checkRateLimit, type RateLimitResult } from "./rate-limit";

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
