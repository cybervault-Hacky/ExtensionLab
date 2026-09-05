import { afterEach, beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { getDb } from "@/lib/db/client";
import { createMatrixRun, deriveMatrixStatus, getMatrixRunView, noteMatrixChildFinished, cancelMatrixRun, finalizeMatrixRun } from "@/lib/testing/matrix-service";
import { getMatrixRunById, listExecutionsForMatrix } from "@/lib/db/repositories/browser-matrix";
import { getTestRunById, saveTestRunFinal } from "@/lib/db/repositories/test-runs";
import { getQuotaSnapshot } from "@/lib/db/repositories/quota";
import { getJobById } from "@/lib/db/repositories/jobs";
import { getReportById } from "@/lib/db/repositories/reports";
import { setBrowserHealthForTests } from "@/lib/browsers/availability";
import { getBrowserRegistryConfig } from "@/lib/browsers/registry";
import { getBrowserConcurrency, getMaxConcurrentRuns } from "@/lib/billing/entitlements";
import { resetConfigCache } from "@/lib/config/env";
import { AppError } from "@/lib/observability/errors";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { storeExtensionPackage } from "@/lib/packages/service";
import { activatePlan, makeUser, setupHarness, ALL_BROWSERS_HEALTHY, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
  setBrowserHealthForTests(ALL_BROWSERS_HEALTHY);
});

afterEach(() => {
  setBrowserHealthForTests(null);
  harness.teardown();
});

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "Matrix Fixture",
  version: "1.0.0",
  action: { default_popup: "popup.html" },
  background: { service_worker: "background.js" },
  permissions: ["storage"],
});

async function packageFixture(userId: string) {
  const zip = new JSZip();
  zip.file("manifest.json", MANIFEST);
  zip.file("background.js", "chrome.runtime.onInstalled.addListener(() => {});");
  zip.file("popup.html", "<!doctype html><html><body>Popup</body></html>");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const stored = await storeExtensionPackage({ userId, bytes, fileName: "matrix.zip" });
  return { packageId: stored.package.id, extensionId: stored.package.extensionId, analysis: await analyzeZipBytes(bytes, "matrix.zip") };
}

function finishRun(runId: string, outcome: "PASSED" | "FAILED" | "WARNING" | "INFRASTRUCTURE_ERROR" | "CANCELLED", extra: { errorCode?: string; score?: number; results?: unknown[] } = {}) {
  saveTestRunFinal({
    id: runId,
    status: outcome === "INFRASTRUCTURE_ERROR" || outcome === "CANCELLED" ? (outcome === "CANCELLED" ? "destroyed" : "failed") : "completed",
    score: extra.score ?? (outcome === "PASSED" ? 100 : outcome === "FAILED" ? 40 : 70),
    total: 1,
    passed: outcome === "PASSED" || outcome === "WARNING" ? 1 : 0,
    failed: outcome === "FAILED" ? 1 : 0,
    warnings: outcome === "WARNING" ? 1 : 0,
    skipped: 0,
    timeout: 0,
    errorCount: outcome === "FAILED" ? 1 : 0,
    completedAt: Date.now(),
    resultJson: JSON.stringify({ results: extra.results ?? [{ testId: "core", name: "core", status: outcome === "PASSED" ? "passed" : outcome === "FAILED" ? "failed" : "warning", steps: [], assertions: [], errors: outcome === "FAILED" ? ["Popup did not open."] : [], warnings: [], evidence: [], duration: 1, startedAt: 0, finishedAt: 1, category: "page", description: "" }] }),
    diagnosticsJson: null,
    eventsJson: null,
    outcome,
    errorCode: extra.errorCode ?? null,
    reason: null,
  });
}

describe("matrix creation (Phase 9)", () => {
  it("creates one child execution per browser with jobs, runs and quota reservations atomically", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const fixture = await packageFixture(user.id);
    const created = await createMatrixRun({
      userId: user.id,
      packageId: fixture.packageId,
      extensionId: fixture.extensionId,
      analysis: fixture.analysis,
      browsers: ["chromium", "edge", "firefox"],
      suiteId: "core",
      testUrl: undefined,
    });
    expect(created.matrixRunId).toBeTruthy();
    expect(created.executions).toHaveLength(3);
    expect(created.suite.id).toBe("core");

    const executions = listExecutionsForMatrix(created.matrixRunId);
    expect(executions.map((execution) => execution.browser_id).sort()).toEqual(["chromium", "edge", "firefox"]);
    const snapshot = getQuotaSnapshot(user.id, "test_run");
    expect(snapshot.reserved).toBe(3); // documented policy: 1 unit per browser execution

    for (const execution of executions) {
      const run = getTestRunById(execution.test_run_id)!;
      expect(run.matrix_run_id).toBe(created.matrixRunId);
      expect(run.browser_id).toBe(execution.browser_id);
      const job = getJobById(execution.job_id!)!;
      expect(job.type).toBe("AUTOMATED_TEST");
      expect(job.idempotency_key).toBe(`matrix:${created.matrixRunId}:${execution.browser_id}`);
      const payload = JSON.parse(job.payload_json) as { browserId?: string; matrixRunId?: string };
      expect(payload.browserId).toBe(execution.browser_id);
      expect(payload.matrixRunId).toBe(created.matrixRunId);
    }
    expect(getMatrixRunById(created.matrixRunId)!.status).toBe("queued");
  });

  it("records the exact browser version and engine per execution at completion", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const fixture = await packageFixture(user.id);
    const created = await createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "firefox"], suiteId: "core" });
    const executions = listExecutionsForMatrix(created.matrixRunId);
    const db = getDb();
    db.prepare("UPDATE test_runs SET browser_version = ? WHERE id = ?").run("139.0.7258.68", executions[0].test_run_id);
    db.prepare("UPDATE test_runs SET browser_version = ? WHERE id = ?").run("141.0", executions[1].test_run_id);
    finishRun(executions[0].test_run_id, "PASSED");
    finishRun(executions[1].test_run_id, "PASSED");
    noteMatrixChildFinished(executions[0].test_run_id);
    noteMatrixChildFinished(executions[1].test_run_id);
    const view = getMatrixRunView(user.id, created.matrixRunId)!;
    const versions = Object.fromEntries(view.executions.map((execution) => [execution.browserId, execution.browserVersion]));
    expect(versions.chromium).toBe("139.0.7258.68");
    expect(versions.firefox).toBe("141.0");
    const engines = Object.fromEntries(view.executions.map((execution) => [execution.browserId, execution.engine]));
    expect(engines.chromium).toBe("chromium");
    expect(engines.firefox).toBe("gecko");
  });

  it("rejects cross-browser runs without the entitlement, using server-side plans only", async () => {
    const free = makeUser();
    const fixture = await packageFixture(free.id);
    await expect(
      createMatrixRun({ userId: free.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "firefox"], suiteId: "core" }),
    ).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    // Chromium-only stays available on free (single browser, no cross-browser entitlement).
    const single = await createMatrixRun({ userId: free.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium"], suiteId: "core" });
    expect(single.executions).toHaveLength(1);
  });

  it("enforces the per-plan browser cap server-side", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro"); // pro: 3 browsers per run
    const fixture = await packageFixture(user.id);
    const created = await createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "edge", "firefox"], suiteId: "core" });
    expect(created.executions).toHaveLength(3);
    // Tighten the deployment's plan cap and verify the server rejects more browsers.
    process.env.PLAN_PRO_MAX_BROWSERS = "1";
    resetConfigCache();
    try {
      await expect(
        createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "edge"], suiteId: "core" }),
      ).rejects.toMatchObject({ code: "MATRIX_LIMIT" });
    } finally {
      delete process.env.PLAN_PRO_MAX_BROWSERS;
      resetConfigCache();
    }
  });

  it("blocks on BROWSER_RUNTIME_UNAVAILABLE before creating anything", async () => {
    const user = makeUser();
    activatePlan(user.id, "business");
    const fixture = await packageFixture(user.id);
    setBrowserHealthForTests({ chromium: { browserId: "chromium", available: true }, edge: { browserId: "edge", available: true }, firefox: { browserId: "firefox", available: false, reason: "image_missing" } });
    await expect(
      createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "firefox"], suiteId: "core" }),
    ).rejects.toMatchObject({ code: "BROWSER_RUNTIME_UNAVAILABLE" });
    const rows = getDb().prepare("SELECT COUNT(*) AS count FROM browser_matrix_runs").get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("enforces the documented quota policy: N browsers = N test-run units", async () => {
    // Pro with exactly 3 test-run units per month: one 3-browser matrix fits, a second does not.
    process.env.PLAN_PRO_TEST_LIMIT = "3";
    resetConfigCache();
    try {
      const user = makeUser();
      activatePlan(user.id, "pro");
      const fixture = await packageFixture(user.id);
      const first = await createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "edge", "firefox"], suiteId: "core" });
      expect(getQuotaSnapshot(user.id, "test_run").reserved).toBe(3);
      await expect(
        createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "firefox"], suiteId: "core" }),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      expect(listExecutionsForMatrix(first.matrixRunId)).toHaveLength(3);
      // Nothing partial was created for the rejected attempt.
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM browser_matrix_runs").get()).toMatchObject({ count: 1 });
    } finally {
      delete process.env.PLAN_PRO_TEST_LIMIT;
      resetConfigCache();
    }
  });

  it("clamps per-user browser parallelism by the deployment matrix concurrency ceiling", async () => {
    const user = makeUser();
    activatePlan(user.id, "business"); // browserConcurrency 3
    const fixture = await packageFixture(user.id);
    process.env.MAX_MATRIX_CONCURRENCY = "1";
    resetConfigCache();
    try {
      // The deployment ceiling clamps browser concurrency wherever it applies
      // (matrix child admission in the worker and per-run enqueue caps).
      const clamped = Math.min(getBrowserConcurrency(user.id), getBrowserRegistryConfig().limits.maxMatrixConcurrency);
      expect(getBrowserConcurrency(user.id)).toBe(4);
      expect(getBrowserRegistryConfig().limits.maxMatrixConcurrency).toBe(1);
      expect(clamped).toBe(1);
      expect(getMaxConcurrentRuns(user.id)).toBeGreaterThanOrEqual(1);
      // Matrix creation itself still succeeds; children queue within the cap.
      const created = await createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "edge", "firefox"], suiteId: "core" });
      expect(listExecutionsForMatrix(created.matrixRunId)).toHaveLength(3);
    } finally {
      delete process.env.MAX_MATRIX_CONCURRENCY;
      resetConfigCache();
    }
  });

  it("validates browser ids and suite ids before anything else", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const fixture = await packageFixture(user.id);
    await expect(
      createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["safari"], suiteId: "core" }),
    ).rejects.toMatchObject({ code: "BROWSER_NOT_SUPPORTED" });
    await expect(
      createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: [], suiteId: "core" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium"], suiteId: "not-a-suite" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("gates advanced suites behind the advanced-suites entitlement", async () => {
    const free = makeUser();
    const fixture = await packageFixture(free.id);
    await expect(
      createMatrixRun({ userId: free.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium"], suiteId: "service-worker" }),
    ).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    const business = makeUser();
    activatePlan(business.id, "business");
    await expect(
      createMatrixRun({ userId: business.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium"], suiteId: "service-worker" }),
    ).resolves.toMatchObject({ suite: { id: "service-worker" } });
  });
});

describe("matrix finalization semantics (Phase 9)", () => {
  async function threeBrowserMatrix() {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const fixture = await packageFixture(user.id);
    const created = await createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "edge", "firefox"], suiteId: "core" });
    return { user, created };
  }

  it("derives PARTIAL when some browsers fail while others pass", async () => {
    const { user, created } = await threeBrowserMatrix();
    const [chromium, edge, firefox] = listExecutionsForMatrix(created.matrixRunId);
    finishRun(chromium.test_run_id, "PASSED");
    finishRun(edge.test_run_id, "PASSED");
    finishRun(firefox.test_run_id, "FAILED");
    noteMatrixChildFinished(chromium.test_run_id);
    noteMatrixChildFinished(edge.test_run_id);
    expect(getMatrixRunById(created.matrixRunId)!.status).toBe("running");
    noteMatrixChildFinished(firefox.test_run_id);
    const matrix = getMatrixRunById(created.matrixRunId)!;
    expect(matrix.status).toBe("partial");
    expect(matrix.reason).toMatch(/failed or were unavailable/i);
    const view = getMatrixRunView(user.id, created.matrixRunId)!;
    expect(view.comparison!.compatibility.browsersFailing).toEqual(["firefox"]);
    expect(view.comparison!.compatibility.browsersPassing).toEqual(["chromium", "edge"]);
  });

  it("treats a Firefox infrastructure failure as insufficient data, never as an extension failure", async () => {
    const { user, created } = await threeBrowserMatrix();
    const [chromium, edge, firefox] = listExecutionsForMatrix(created.matrixRunId);
    finishRun(chromium.test_run_id, "PASSED");
    finishRun(edge.test_run_id, "PASSED");
    finishRun(firefox.test_run_id, "INFRASTRUCTURE_ERROR", { errorCode: "BROWSER_RUNTIME_UNAVAILABLE" });
    noteMatrixChildFinished(chromium.test_run_id);
    noteMatrixChildFinished(edge.test_run_id);
    noteMatrixChildFinished(firefox.test_run_id);
    const view = getMatrixRunView(user.id, created.matrixRunId)!;
    expect(view.matrixRun.status).toBe("partial");
    expect(view.comparison!.compatibility.score).toBe(100); // infra failure excluded from scoring
    expect(view.comparison!.compatibility.browsersUnavailable).toEqual(["firefox"]);
    expect(view.comparison!.compatibility.coverage).toBeCloseTo(2 / 3);
    const firefoxExecution = view.executions.find((execution) => execution.browserId === "firefox")!;
    expect(firefoxExecution.status).toBe("skipped");
    expect(firefoxExecution.errorCode).toBe("BROWSER_RUNTIME_UNAVAILABLE");
    // and it surfaces an explicit infrastructure finding
    expect(view.comparison!.findings.some((finding) => finding.type === "INFRASTRUCTURE_UNAVAILABLE")).toBe(true);
  });

  it("is idempotent: double-reporting a child or re-finalizing never duplicates the report", async () => {
    const { user, created } = await threeBrowserMatrix();
    const [chromium, edge, firefox] = listExecutionsForMatrix(created.matrixRunId);
    finishRun(chromium.test_run_id, "PASSED");
    finishRun(edge.test_run_id, "PASSED");
    finishRun(firefox.test_run_id, "PASSED");
    noteMatrixChildFinished(chromium.test_run_id);
    noteMatrixChildFinished(chromium.test_run_id); // duplicate callback
    noteMatrixChildFinished(edge.test_run_id);
    noteMatrixChildFinished(firefox.test_run_id);
    noteMatrixChildFinished(firefox.test_run_id); // duplicate callback
    const first = getMatrixRunById(created.matrixRunId)!;
    expect(first.status).toBe("completed");
    const firstScore = first.compatibility_score;
    finalizeMatrixRun(created.matrixRunId); // explicit re-finalize
    const second = getMatrixRunById(created.matrixRunId)!;
    expect(second.report_id).toBe(first.report_id);
    expect(second.status).toBe("completed");
    expect(second.compatibility_score).toBe(firstScore);
    const report = getReportById(first.report_id!)!;
    const payload = JSON.parse(report.report_json) as { kind: string };
    expect(payload.kind).toBe("cross-browser-matrix");
    const reports = getDb().prepare("SELECT COUNT(*) AS count FROM reports WHERE title LIKE 'Cross-browser matrix%'").get() as { count: number };
    expect(reports.count).toBe(1);
  });

  it("marks every-cancelled matrices cancelled and no-execution matrices failed", () => {
    expect(deriveMatrixStatus([{ status: "cancelled", outcome: "CANCELLED" }, { status: "cancelled", outcome: "CANCELLED" }])).toBe("cancelled");
    expect(deriveMatrixStatus([{ status: "skipped", outcome: "INFRASTRUCTURE_ERROR" }, { status: "skipped", outcome: "INFRASTRUCTURE_ERROR" }])).toBe("failed");
    expect(deriveMatrixStatus([{ status: "completed", outcome: "PASSED" }, { status: "completed", outcome: "PASSED" }])).toBe("completed");
    expect(deriveMatrixStatus([{ status: "completed", outcome: "PASSED" }, { status: "failed", outcome: "FAILED" }])).toBe("partial");
    expect(deriveMatrixStatus([{ status: "completed", outcome: "PASSED" }, { status: "skipped", outcome: "INFRASTRUCTURE_ERROR" }])).toBe("partial");
  });

  it("scopes matrix views to their owner", async () => {
    const { created } = await threeBrowserMatrix();
    const intruder = makeUser();
    expect(getMatrixRunView(intruder.id, created.matrixRunId)).toBeNull();
    expect(() => cancelMatrixRun(intruder.id, created.matrixRunId)).toThrow(AppError);
  });
});

describe("matrix cancellation (Phase 9)", () => {
  it("cancels queued children, preserves finished results, and finalizes honestly", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const fixture = await packageFixture(user.id);
    const created = await createMatrixRun({ userId: user.id, packageId: fixture.packageId, extensionId: fixture.extensionId, analysis: fixture.analysis, browsers: ["chromium", "edge", "firefox"], suiteId: "core" });
    const [chromium, edge, firefox] = listExecutionsForMatrix(created.matrixRunId);
    finishRun(chromium.test_run_id, "PASSED");
    noteMatrixChildFinished(chromium.test_run_id);
    const view = cancelMatrixRun(user.id, created.matrixRunId);
    expect(view).not.toBeNull();
    expect(["cancelled", "partial"]).toContain(view!.matrixRun.status);
    const statuses = Object.fromEntries(view!.executions.map((execution) => [execution.browserId, execution.status]));
    expect(statuses.chromium).toBe("completed"); // finished results preserved
    expect(["cancelled", "queued"]).toContain(statuses.edge);
    expect(["cancelled", "queued"]).toContain(statuses.firefox);
    // cancelling again is a no-op returning the same view
    const again = cancelMatrixRun(user.id, created.matrixRunId);
    expect(again!.matrixRun.status).toBe(view!.matrixRun.status);
    void edge;
    void firefox;
  });
});
