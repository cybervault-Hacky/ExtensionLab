import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createReport, setReportPinned, getReportById } from "@/lib/db/repositories/reports";
import { createTestRun } from "@/lib/db/repositories/test-runs";
import { createArtifactRecord, listArtifactsForRun } from "@/lib/db/repositories/artifacts";
import { deleteExpiredArtifacts } from "@/lib/artifacts/service";
import { setStorageForTests } from "@/lib/storage/storage";
import { LocalStorageProvider } from "@/lib/storage/local";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeUser, setupPhase13Harness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness();
  const dir = mkdtempSync(join(tmpdir(), "el-p13-ret-"));
  setStorageForTests(new LocalStorageProvider(join(dir, "storage")));
});

afterEach(() => {
  harness.teardown();
});

function seedRunWithExpiringArtifact(userId: string, expiresInPast = true): { runId: string; reportId: string } {
  // A finished test run + report + artifact that is already past retention.
  const runId = createTestRun({ userId, extensionId: null, status: "completed", total: 5 }).id;
  const report = createReport({
    userId,
    extensionId: null,
    analysisSnapshotId: null,
    testRunId: runId,
    title: "Retention pinning report",
    summary: null,
    healthScore: 90,
    runtimeScore: 80,
    overallScore: 85,
    reportJson: "{}",
  });
  createArtifactRecord({
    testRunId: runId,
    userId,
    type: "screenshot",
    storageKey: `artifacts/${runId}/shot.png`,
    size: 10,
    sha256: "0".repeat(64),
    contentType: "image/png",
    expiresAt: expiresInPast ? Date.now() - 1000 : Date.now() + 3_600_000,
  });
  return { runId, reportId: report.id };
}

/** § artifact retention respects report pinning: pinned reports keep evidence. */
describe("Phase 13: artifact retention respects report pinning", () => {
  it("keeps expired artifacts while their report is pinned, deletes after unpin", async () => {
    const user = makeUser();
    const { runId, reportId } = seedRunWithExpiringArtifact(user.id);

    // Pin the report: the expired artifact must survive retention.
    expect(setReportPinned(user.id, reportId, true)!.pinned_at).toBeGreaterThan(0);
    expect(await deleteExpiredArtifacts()).toBe(0);
    expect(listArtifactsForRun(runId)).toHaveLength(1);

    // Unpin: the same artifact becomes collectable.
    expect(setReportPinned(user.id, reportId, false)!.pinned_at).toBeNull();
    expect(await deleteExpiredArtifacts()).toBe(1);
    expect(listArtifactsForRun(runId)).toHaveLength(0);
  });

  it("pinning is ownership-checked and never touches other users' reports", () => {
    const owner = makeUser();
    const other = makeUser();
    const { reportId } = seedRunWithExpiringArtifact(owner.id);
    expect(setReportPinned(other.id, reportId, true)).toBeNull();
    expect(getReportById(reportId)!.pinned_at ?? null).toBeNull();
  });

  it("unrelated expired artifacts are still collected while a report is pinned", async () => {
    const user = makeUser();
    const pinned = seedRunWithExpiringArtifact(user.id);
    const orphan = seedRunWithExpiringArtifact(user.id);
    setReportPinned(user.id, pinned.reportId, true);

    expect(await deleteExpiredArtifacts()).toBe(1); // only the orphan run's artifact
    expect(listArtifactsForRun(pinned.runId)).toHaveLength(1);
    expect(listArtifactsForRun(orphan.runId)).toHaveLength(0);
  });
});
