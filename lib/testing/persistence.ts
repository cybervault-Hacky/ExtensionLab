import "server-only";
import {
  createTestRun,
  getTestRunById,
  saveTestRunFinal,
  updateTestRunStarted,
  updateTestRunStatus,
} from "@/lib/db/repositories/test-runs";
import { getOwnedExtension, markExtensionTested } from "@/lib/db/repositories/extensions";
import { countUsageThisMonth, recordUsage } from "@/lib/db/repositories/usage";
import { getActivePlan } from "@/lib/db/plan";
import { exportTestResults } from "./diagnostics";
import type {
  DiagnosticFinding,
  TestResult,
  TestRunInfo,
  TestRunSnapshot,
  TestScore,
} from "./types";
import type { TestRunPersistenceHooks } from "./test-runner";

const pendingByUser = new Map<string, Set<string>>();

export function canCreateTestRun(userId: string): boolean {
  const plan = getActivePlan();
  const used = countUsageThisMonth(userId, "test_run");
  const pending = pendingByUser.get(userId)?.size ?? 0;
  return used + pending < plan.testRunLimit;
}

export function registerPendingTestRun(runId: string, userId: string): void {
  let set = pendingByUser.get(userId);
  if (!set) {
    set = new Set();
    pendingByUser.set(userId, set);
  }
  set.add(runId);
}

export function releasePendingTestRun(runId: string): void {
  for (const [userId, set] of pendingByUser) {
    if (set.delete(runId) && set.size === 0) {
      pendingByUser.delete(userId);
      return;
    }
  }
}

export function createTestRunPersistence(): TestRunPersistenceHooks {
  return {
    onStatus(snap: TestRunSnapshot, info: TestRunInfo): void {
      const row = getTestRunById(snap.runId);
      if (!row) return;
      if (info.state === "running") {
        updateTestRunStarted(snap.runId);
        if (!pendingByUser.get(row.user_id)?.has(snap.runId)) return;
        pendingByUser.get(row.user_id)?.delete(snap.runId);
        if (pendingByUser.get(row.user_id)?.size === 0) {
          pendingByUser.delete(row.user_id);
        }
        recordUsage(row.user_id, "test_run");
      } else {
        updateTestRunStatus(snap.runId, info.state);
      }
      if (info.state === "failed" || info.state === "destroyed") {
        releasePendingTestRun(snap.runId);
      }
    },

    onFinished(snap: TestRunSnapshot, info: TestRunInfo): void {
      const row = getTestRunById(snap.runId);
      if (!row) return;
      const extension = row.extension_id ? getOwnedExtension(row.user_id, row.extension_id) : null;
      const resultJson = exportTestResults({
        runId: snap.runId,
        extensionName: extension?.name,
        extensionVersion: extension?.version ?? undefined,
        results: snap.results as TestResult[],
        diagnostics: snap.diagnostics as DiagnosticFinding[],
        score: snap.score as TestScore,
        timestamps: {
          createdAt: snap.createdAt,
          startedAt: snap.startedAt,
          finishedAt: snap.finishedAt,
        },
      });
      saveTestRunFinal({
        id: snap.runId,
        status: info.state,
        score: info.score,
        total: info.total,
        passed: info.passed,
        failed: info.failed,
        warnings: info.warning,
        skipped: info.skipped,
        timeout: info.timeout,
        errorCount: info.error,
        completedAt: snap.finishedAt ?? Date.now(),
        resultJson: JSON.stringify(resultJson),
        diagnosticsJson: JSON.stringify(snap.diagnostics),
        eventsJson: JSON.stringify(snap.events.slice(-200)),
      });
      releasePendingTestRun(snap.runId);
      if (row.extension_id) {
        markExtensionTested({ id: row.extension_id, status: info.state });
      }
    },
  };
}

/** Used by the create API after TestRunManager.create succeeds. */
export function persistNewTestRun(input: {
  runId: string;
  userId: string;
  extensionId: string | null;
  createdAt?: number;
}): void {
  createTestRun({
    userId: input.userId,
    extensionId: input.extensionId,
    status: "idle",
    runId: input.runId,
    createdAt: input.createdAt,
  });
}
