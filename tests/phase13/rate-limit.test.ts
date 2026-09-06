import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { checkRateLimit, resetRateLimit } from "@/lib/auth/rate-limit";
import { setupPhase13Harness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness({ RATE_LIMIT_LOGIN_PER_MIN: "3" });
});

afterEach(() => {
  harness.teardown();
});

/**
 * §58: rate limits must hold across multiple web instances. The memory
 * coordination provider shares the fixed-window implementation with the
 * per-process limiter; the Redis provider makes the same counters fleet-wide.
 */
describe("Phase 13 §58: distributed rate limiting", () => {
  it("counts across the shared store, not per call site", async () => {
    resetRateLimit("login:9.9.9.9");
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await enforceRateLimitAsync("login", "9.9.9.9"));
    }
    expect(results.slice(0, 3).every((entry) => entry.ok)).toBe(true);
    expect(results[3].ok).toBe(false);
    expect(results[3].retryAfterSeconds).toBeGreaterThan(0);
    resetRateLimit("login:9.9.9.9");
  });

  it("isolates different client keys", async () => {
    resetRateLimit("login:a");
    resetRateLimit("login:b");
    expect((await enforceRateLimitAsync("login", "a")).ok).toBe(true);
    expect((await enforceRateLimitAsync("login", "b")).ok).toBe(true);
  });

  it("shares counters between the sync policy and the coordination path", async () => {
    resetRateLimit("login:shared");
    // The configured login limit is 3 in this harness.
    expect(checkRateLimit("login:shared", 3, 60_000).ok).toBe(true); // 1/3 used
    expect((await enforceRateLimitAsync("login", "shared")).ok).toBe(true); // 2/3 used
    expect((await enforceRateLimitAsync("login", "shared")).ok).toBe(true); // 3/3 used
    expect((await enforceRateLimitAsync("login", "shared")).ok).toBe(false); // capped
    resetRateLimit("login:shared");
  });
});
