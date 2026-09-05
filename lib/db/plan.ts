import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";

export interface Plan {
  id: string;
  name: string;
  analysisLimit: number;
  testRunLimit: number;
  maxExtensionSize: number;
  maxConcurrentRuns: number;
  historyRetentionDays: number;
}

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export function getActivePlan(): Plan {
  return {
    id: "free",
    name: "Free",
    analysisLimit: numberFromEnv(process.env.PLAN_ANALYSIS_LIMIT, 10),
    testRunLimit: numberFromEnv(process.env.PLAN_TEST_LIMIT, 5),
    maxExtensionSize: numberFromEnv(
      process.env.PLAN_MAX_EXTENSION_SIZE,
      MAX_EXTENSION_SIZE,
    ),
    maxConcurrentRuns: numberFromEnv(process.env.PLAN_MAX_CONCURRENT_RUNS, 2),
    historyRetentionDays: numberFromEnv(process.env.PLAN_HISTORY_RETENTION_DAYS, 30),
  };
}
