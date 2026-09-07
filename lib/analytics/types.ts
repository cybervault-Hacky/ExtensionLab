/** Phase 19 — Analytics types. Strongly typed; no arbitrary data. */
export type MetricStatus = "available" | "insufficient_data" | "no_data";

export interface MetricValue {
  value: number | null;
  status: MetricStatus;
  unit?: string;
  previous?: number | null;
  change?: number | null;
  note?: string;
}

export interface TimeSeriesPoint {
  label: string;
  value: number;
}

export interface ExtensionAnalytics {
  extensionId: string;
  extensionName: string | null;
  currentHealth: MetricValue;
  previousHealth: MetricValue | null;
  latestAnalysisAt: number | null;
  testsExecuted: MetricValue;
  passRate: MetricValue;
  failureRate: MetricValue;
  regressionCount: MetricValue;
  ciSuccessRate: MetricValue;
  browserCompatibility: MetricValue;
}

export interface OverviewAnalytics {
  extensionsAnalyzed: MetricValue;
  recentTests: MetricValue;
  testPassRate: MetricValue;
  ciRuns: MetricValue;
  ciSuccessRate: MetricValue;
  regressionsDetected: MetricValue;
  averageTestDurationMs: MetricValue;
}
