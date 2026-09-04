import "server-only";

/**
 * Phase 4 test-engine limits. These are intentionally configurable from one
 * place and never repeated as magic numbers through the codebase.
 */

export const TEST_ENGINE_CONFIG = {
  /** Per-test timeout. */
  TEST_TIMEOUT: 10 * 1000,
  /** Per-suite timeout. */
  SUITE_TIMEOUT: 60 * 1000,
  /** Hard upper bound for an entire automated run. */
  MAX_TEST_RUN_TIME: 120 * 1000,
  /** Maximum actions that one test may perform. */
  MAX_ACTIONS_PER_TEST: 24,
  /** Maximum wait duration for a single wait action. */
  MAX_WAIT_MS: 5000,
  /** Maximum selector length. */
  MAX_SELECTOR_LENGTH: 200,
  /** Maximum test count in a run. */
  MAX_TESTS_PER_RUN: 32,
  /** Maximum concurrent automated test runs. */
  MAX_CONCURRENT_TEST_RUNS: 2,
  /** Per-IP automated test runs per window. */
  MAX_TEST_RUNS_PER_WINDOW: 4,
  /** Rate-limit window for automated runs. */
  TEST_RATE_LIMIT_WINDOW_MS: 60 * 1000,
  /** Artifact limits. */
  MAX_SCREENSHOTS: 8,
  MAX_EVENTS: 600,
  MAX_NETWORK_EVENTS: 200,
  MAX_TEST_RESULTS: 64,
  MAX_ARTIFACT_SIZE: 8 * 1024 * 1024,
  /** Default test page used as the controlled origin. */
  DEFAULT_TEST_PAGE_URL: "http://127.0.0.1:8080/extensionlab-test",
} as const;

export function testConfig(): typeof TEST_ENGINE_CONFIG {
  return TEST_ENGINE_CONFIG;
}
