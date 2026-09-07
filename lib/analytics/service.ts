import { getDb } from "@/lib/db/client";
import type { OverviewAnalytics, ExtensionAnalytics, MetricValue } from "./types";

function metric(value: number | null, status: "available" | "insufficient_data" | "no_data", unit?: string, previous?: number | null): MetricValue {
  const change = (value !== null && previous !== null) ? (value - previous) : null;
  return { value, status, unit, previous: previous ?? null, change, note: status === "insufficient_data" ? "Not enough data" : status === "no_data" ? "No data available yet" : undefined };
}

function safeCount(query: string, params: (string | number)[] = []): number {
  const db = getDb();
  try {
    const r = db.prepare(query).get(...params) as { c: number | bigint } | undefined;
    return r ? Number(r.c) : 0;
  } catch {
    return 0;
  }
}

export function getOverviewAnalytics(): OverviewAnalytics {
  const db = getDb();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const extensionsAnalyzed = safeCount("SELECT COUNT(DISTINCT extension_id) AS c FROM analysis_snapshots WHERE created_at > ?", [thirtyDaysAgo]);
  const recentTests = safeCount("SELECT COUNT(*) AS c FROM test_runs WHERE created_at > ? AND status IN ('completed','failed')", [thirtyDaysAgo]);
  const passedTests = safeCount("SELECT SUM(passed) AS c FROM test_runs WHERE created_at > ? AND status = 'completed'", [thirtyDaysAgo]);
  const totalCompleted = safeCount("SELECT COUNT(*) AS c FROM test_runs WHERE created_at > ? AND status = 'completed'", [thirtyDaysAgo]);
  const passRate = totalCompleted > 0 ? Math.round((passedTests / totalCompleted) * 10000) / 100 : null;
  const ciRuns = safeCount("SELECT COUNT(*) AS c FROM test_runs WHERE created_at > ? AND (saved_test_id IS NOT NULL OR source = 'ci')", [thirtyDaysAgo]);
  const ciFailed = safeCount("SELECT COUNT(*) AS c FROM test_runs WHERE created_at > ? AND (saved_test_id IS NOT NULL OR source = 'ci') AND status = 'failed'", [thirtyDaysAgo]);
  const ciSuccessRate = ciRuns > 0 ? Math.round(((ciRuns - ciFailed) / ciRuns) * 10000) / 100 : null;
  const regressions = safeCount("SELECT COUNT(*) AS c FROM regressions WHERE created_at > ?", [thirtyDaysAgo]);
  const avgDur = safeCount("SELECT AVG(duration_ms) AS c FROM test_runs WHERE created_at > ? AND duration_ms IS NOT NULL AND duration_ms > 0", [thirtyDaysAgo]);

  return {
    extensionsAnalyzed: metric(extensionsAnalyzed > 0 ? extensionsAnalyzed : null, extensionsAnalyzed > 0 ? "available" : "no_data"),
    recentTests: metric(recentTests > 0 ? recentTests : null, recentTests > 0 ? "available" : "no_data"),
    testPassRate: metric(passRate, passRate !== null ? "available" : "insufficient_data", "%"),
    ciRuns: metric(ciRuns > 0 ? ciRuns : null, ciRuns > 0 ? "available" : "no_data"),
    ciSuccessRate: metric(ciSuccessRate, ciSuccessRate !== null ? "available" : "insufficient_data", "%"),
    regressionsDetected: metric(regressions > 0 ? regressions : null, regressions >= 0 ? "available" : "no_data"),
    averageTestDurationMs: metric(avgDur > 0 ? avgDur : null, avgDur > 0 ? "available" : "insufficient_data", "ms"),
  };
}

export function getExtensionAnalytics(extensionId: string): ExtensionAnalytics {
  const db = getDb();
  const latestAnalysis = db.prepare("SELECT health_score, created_at FROM analysis_snapshots WHERE extension_id = ? ORDER BY created_at DESC LIMIT 1").get(extensionId) as { health_score: number; created_at: number } | undefined;
  const prevAnalysis = db.prepare("SELECT health_score FROM analysis_snapshots WHERE extension_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET 1").get(extensionId) as { health_score: number } | undefined;

  const totalTests = safeCount("SELECT COUNT(*) AS c FROM test_runs WHERE extension_id = ? AND status IN ('completed','failed')", [extensionId]);
  const passedTests = safeCount("SELECT SUM(passed) AS c FROM test_runs WHERE extension_id = ? AND status = 'completed'", [extensionId]);
  const passRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 10000) / 100 : null;
  const failureRate = totalTests > 0 ? Math.round(((totalTests - passedTests) / totalTests) * 10000) / 100 : null;

  const regressionCount = safeCount("SELECT COUNT(*) AS c FROM regressions WHERE extension_id = ? OR package_sha256 IN (SELECT sha256 FROM packages WHERE extension_id = ?)", [extensionId, extensionId]);
  const ciSuccessRate = null; // CI data not directly linked to extension_id; kept null to avoid false claims

  // Browser compatibility: only if browser matrix exists for extension
  const browserRuns = safeCount("SELECT COUNT(*) AS c FROM browser_matrix_runs WHERE extension_id = ?", [extensionId]);
  const browserPass = safeCount("SELECT COUNT(*) AS c FROM browser_matrix_runs WHERE extension_id = ? AND outcome = 'PASS'", [extensionId]);
  const browserComp = browserRuns > 0 ? Math.round((browserPass / browserRuns) * 10000) / 100 : null;

  return {
    extensionId,
    extensionName: (db.prepare("SELECT name FROM extensions WHERE id = ?").get(extensionId) as { name: string } | undefined)?.name ?? null,
    currentHealth: metric(latestAnalysis ? latestAnalysis.health_score : null, latestAnalysis ? "available" : "no_data"),
    previousHealth: metric(prevAnalysis ? prevAnalysis.health_score : null, prevAnalysis ? "available" : "insufficient_data"),
    latestAnalysisAt: latestAnalysis ? latestAnalysis.created_at : null,
    testsExecuted: metric(totalTests > 0 ? totalTests : null, totalTests > 0 ? "available" : "no_data"),
    passRate: metric(passRate, passRate !== null ? "available" : "insufficient_data", "%"),
    failureRate: metric(failureRate, failureRate !== null ? "available" : "insufficient_data", "%"),
    regressionCount: metric(regressionCount > 0 ? regressionCount : null, regressionCount >= 0 ? "available" : "no_data"),
    ciSuccessRate: metric(ciSuccessRate, ciSuccessRate !== null ? "available" : "no_data", "%"),
    browserCompatibility: metric(browserComp, browserComp !== null ? "available" : "insufficient_data", "%"),
  };
}
