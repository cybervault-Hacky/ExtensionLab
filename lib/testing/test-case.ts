import type { TestCase, TestCaseInput, TestDiscoveryContext } from "./types";

/**
 * Create a well-formed test case with deterministic defaults.
 */

export function createTestCase(input: TestCaseInput): TestCase {
  return {
    ...input,
    timeout: input.timeout,
  };
}

export function isTestApplicable(
  test: TestCase,
  context: TestDiscoveryContext,
): boolean {
  return test.applicable(context);
}
