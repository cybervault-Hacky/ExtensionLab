import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  allBreakerSnapshots,
  breakerAllows,
  breakerSnapshot,
  recordBreakerFailure,
  recordBreakerSuccess,
  resetBreakersForTests,
} from "@/lib/runtime/breaker";
import { setupPhase13Harness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness();
  resetBreakersForTests();
});

afterEach(() => {
  resetBreakersForTests();
  harness.teardown();
});

/** §26: deterministic circuit breaker — HEALTHY → DEGRADED → OPEN → RECOVERY → HEALTHY. */
describe("Phase 13 §26: browser-start circuit breaker", () => {
  it("opens after the failure threshold and fails fast with a bounded retry hint", () => {
    let now = 1_000_000;
    const key = "interactive:chromium";
    expect(breakerAllows(key, now).state).toBe("HEALTHY");

    for (let i = 0; i < 4; i += 1) recordBreakerFailure(key, now);
    expect(breakerSnapshot(key, now).state).toBe("DEGRADED");
    expect(breakerAllows(key, now).allowed).toBe(true);

    recordBreakerFailure(key, now); // 5th failure within the window
    const open = breakerAllows(key, now);
    expect(open.state).toBe("OPEN");
    expect(open.allowed).toBe(false);
    expect(open.retryAfterMs).toBeGreaterThan(0);

    // The cooldown is deterministic: still open just before, recoverable after.
    expect(breakerAllows(key, now + 59_999).state).toBe("OPEN");
    expect(breakerAllows(key, now + 60_000).state).toBe("RECOVERY");
    expect(breakerAllows(key, now + 60_000).allowed).toBe(true);
    void now;
  });

  it("a probe failure during RECOVERY re-opens immediately", () => {
    let now = 2_000_000;
    const key = "tests:chromium";
    for (let i = 0; i < 5; i += 1) recordBreakerFailure(key, now);
    expect(breakerAllows(key, now).state).toBe("OPEN");

    now += 60_000; // cooldown elapsed → recovery probes allowed
    expect(breakerAllows(key, now).state).toBe("RECOVERY");
    recordBreakerFailure(key, now); // probe failed
    expect(breakerAllows(key, now).state).toBe("OPEN");
    void now;
  });

  it("success during RECOVERY closes the breaker only after enough probes", () => {
    let now = 3_000_000;
    const key = "interactive:chromium";
    for (let i = 0; i < 5; i += 1) recordBreakerFailure(key, now);
    now += 60_000;
    expect(breakerAllows(key, now).state).toBe("RECOVERY");

    recordBreakerSuccess(key, now);
    expect(breakerSnapshot(key, now).state).toBe("RECOVERY"); // one probe is not enough
    recordBreakerSuccess(key, now);
    expect(breakerSnapshot(key, now).state).toBe("HEALTHY"); // closed, counters reset
    void now;
  });

  it("failure windows slide: old failures expire", () => {
    let now = 4_000_000;
    const key = "interactive:edge";
    for (let i = 0; i < 4; i += 1) recordBreakerFailure(key, now);
    now += 121_000; // beyond the 120s window
    recordBreakerFailure(key, now);
    expect(breakerSnapshot(key, now).state).toBe("DEGRADED"); // old failures expired
    void now;
  });

  it("breakers are isolated per key and snapshots are bounded", () => {
    recordBreakerFailure("interactive:chromium", Date.now());
    recordBreakerFailure("tests:firefox", Date.now());
    const snapshots = allBreakerSnapshots();
    expect(snapshots.map((entry) => entry.key).sort()).toEqual(["interactive:chromium", "tests:firefox"]);
    for (const entry of snapshots) expect(entry.failuresInWindow).toBe(1);
  });
});
