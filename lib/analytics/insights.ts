/** Phase 19 — Deterministic insights from real analytics data. No AI authoring. */
import type { OverviewAnalytics, ExtensionAnalytics } from "./types";

export interface Insight {
  title: string;
  evidence: string;
  confidence: "confirmed" | "observed" | "potential" | "insufficient_data";
  category: string;
}

export function generateOverviewInsights(overview: OverviewAnalytics): Insight[] {
  const insights: Insight[] = [];
  if (overview.regressionsDetected.status === "available" && overview.regressionsDetected.value !== null && overview.regressionsDetected.value > 0) {
    insights.push({ title: "Regressions detected", evidence: `Regression count: ${overview.regressionsDetected.value}`, confidence: "confirmed", category: "Regression" });
  }
  if (overview.testPassRate.status === "available" && overview.testPassRate.value !== null) {
    if (overview.testPassRate.value < 80) {
      insights.push({ title: "Test pass rate below 80%", evidence: `Pass rate: ${overview.testPassRate.value}%`, confidence: "observed", category: "Testing" });
    } else if (overview.testPassRate.value >= 95) {
      insights.push({ title: "High test reliability", evidence: `Pass rate: ${overview.testPassRate.value}%`, confidence: "confirmed", category: "Testing" });
    }
  }
  if (overview.ciSuccessRate.status === "available" && overview.ciSuccessRate.value !== null && overview.ciSuccessRate.value < 80) {
    insights.push({ title: "CI success rate degraded", evidence: `CI success: ${overview.ciSuccessRate.value}%`, confidence: "observed", category: "CI/CD" });
  }
  return insights;
}
