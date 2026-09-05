import type { TestSuite, TestSuiteInput } from "./types";

export function createTestSuite(input: TestSuiteInput): TestSuite {
  return {
    ...input,
    tests: input.tests.slice(),
  };
}

export function countTests(suite: TestSuite): number {
  return suite.tests.length;
}
