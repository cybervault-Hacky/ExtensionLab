/**
 * Real-Docker cross-browser end-to-end suite (Phase 9).
 *
 * Exercises the multi-browser path with no doubles: matrix creation → per
 * browser child jobs → per-browser disposable containers (chromium / edge /
 * firefox pinned images) → real browsers → deterministic comparison →
 * cross-browser report → quota accounting. Regression A/B, quota and billing
 * gates run against the same real pipeline.
 *
 * Requirements: Docker CLI + daemon and the per-browser sandbox images
 * (`npm run sandbox:build:matrix`). When they are missing the suite skips
 * itself with an explicit reason — unless EXTENSIONLAB_E2E_DOCKER=1 (CI) is
 * set, in which case "unavailable" is a hard failure. Results are never
 * faked: no browser result is invented when an image is absent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { closeDb, getDb } from "@/lib/db/client";
import { getConfig, resetConfigCache } from "@/lib/config/env";
import { createStorageProvider, setStorageForTests } from "@/lib/storage/storage";
import { setLogLevel } from "@/lib/observability/logger";
import { createUser } from "@/lib/db/repositories/users";
import { upsertBillingCustomer, upsertSubscription } from "@/lib/db/repositories/billing";
import { storeExtensionPackage } from "@/lib/packages/service";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { countUsageThisMonth } from "@/lib/db/repositories/usage";
import { createExtension } from "@/lib/db/repositories/extensions";
import { setBaseline } from "@/lib/db/repositories/baselines";
import { getMatrixRunById, listExecutionsForMatrix } from "@/lib/db/repositories/browser-matrix";
import { getReportById } from "@/lib/db/repositories/reports";
import { JobWorker } from "@/lib/jobs/worker";
import { createAutomatedTestHandler } from "@/lib/jobs/handlers/automated-test";
import { SandboxManager } from "@/lib/runtime/sandbox-manager";
import { createDockerDriver } from "@/lib/runtime/docker-driver";
import { probeSandboxEnvironment, resetSandboxProbeCache } from "@/lib/runtime/availability";
import { getBrowserRuntimesHealth, setBrowserHealthForTests } from "@/lib/browsers/availability";
import type { BrowserId } from "@/lib/browsers/types";
import { createMatrixRun, cancelMatrixRun, getMatrixRunView } from "@/lib/testing/matrix-service";
import { compareForRegression } from "@/lib/testing/regression-service";
import { createQueuedTestRun, parseResults } from "@/lib/testing/run-service";
import { AppError } from "@/lib/observability/errors";

const execFileAsync = promisify(execFile);
const dockerBin = process.env.DOCKER_BIN || "docker";
const image = process.env.SANDBOX_IMAGE || "extensionlab-sandbox:local";
const mustRun = process.env.EXTENSIONLAB_E2E_DOCKER === "1";
const fixtures = join(process.cwd(), "tests", "e2e", "fixtures");
const FINAL = ["completed", "failed", "timeout", "destroyed"];

async function listSandboxContainers(): Promise<string[]> {
  const { stdout } = await execFileAsync(dockerBin, ["ps", "-a", "--filter", "label=extensionlab.sandbox=1", "--format", "{{.ID}}"], { timeout: 15_000 });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function zipDirectory(dir: string): Promise<Uint8Array> {
  const zip = new JSZip();
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else zip.file(`${prefix}${entry}`, readFileSync(full));
    }
  };
  walk(dir, "");
  return zip.generateAsync({ type: "uint8array" });
}

async function detectDocker(): Promise<{ available: boolean; reason: string }> {
  resetSandboxProbeCache();
  const probe = await probeSandboxEnvironment(true);
  if (probe.available) return { available: true, reason: "" };
  const reasons: Record<string, string> = {
    disabled: "SANDBOX_DISABLED=true in this environment",
    docker_missing: "Docker CLI is not installed",
    docker_unreachable: "Docker daemon is not reachable",
    image_missing: `sandbox image "${image}" is not built (run: npm run sandbox:build)`,
  };
  return { available: false, reason: reasons[probe.reason ?? ""] ?? "unknown" };
}

const docker = await detectDocker();
const health = docker.available ? await getBrowserRuntimesHealth(true) : null;
const availableBrowsers: BrowserId[] = health
  ? (["chromium", "edge", "firefox"] as BrowserId[]).filter((id) => health[id]?.available)
  : [];
const missingBrowsers: BrowserId[] = health
  ? (["chromium", "edge", "firefox"] as BrowserId[]).filter((id) => !health![id]?.available)
  : [];
const crossBrowserReady = availableBrowsers.length >= 2;

if (mustRun && !docker.available) {
  throw new Error(`Cross-browser Docker E2E required (EXTENSIONLAB_E2E_DOCKER=1) but unavailable: ${docker.reason}`);
}
if (mustRun && missingBrowsers.length > 0) {
  throw new Error(
    `Cross-browser Docker E2E required (EXTENSIONLAB_E2E_DOCKER=1) but browser images are missing for: ${missingBrowsers.join(", ")} (run: npm run sandbox:build:matrix)`,
  );
}
const suite = docker.available ? describe : describe.skip;
if (!docker.available) {
  // eslint-disable-next-line no-console
  console.warn(`[e2e] skipping cross-browser Docker suite: ${docker.reason}`);
} else if (!crossBrowserReady) {
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] cross-browser matrix tests need at least two built browser images; available: [${availableBrowsers.join(", ") || "none"}] — run npm run sandbox:build:matrix`,
  );
}

/** Paid-plan activation exactly like a verified provider webhook would do. */
function activatePlan(userId: string, planId: "pro" | "business"): void {
  const now = Date.now();
  upsertBillingCustomer({ userId, provider: "fake", providerCustomerId: `cust_${userId}` });
  upsertSubscription({
    userId,
    provider: "fake",
    providerCustomerId: `cust_${userId}`,
    providerSubscriptionId: `sub_${userId}_${planId}`,
    providerPriceId: `price_${planId}_test`,
    planId,
    status: "active",
    currentPeriodStart: now - 1000,
    currentPeriodEnd: now + 30 * 24 * 3600 * 1000,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    canceledAt: null,
    trialEnd: null,
    endedAt: null,
    eventAt: now,
  });
}

suite("real cross-browser Docker end-to-end (Phase 9)", () => {
  let dir: string;
  let sandboxManager: SandboxManager;
  let worker: JobWorker;
  let containersBefore: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "el-p9-e2e-"));
    closeDb();
    resetConfigCache();
    process.env.APP_ENV = "test";
    process.env.EXTENSIONLAB_DB_PATH = join(dir, "db.sqlite");
    delete process.env.DATABASE_URL;
    process.env.STORAGE_PATH = join(dir, "storage");
    process.env.SANDBOX_TEMP_ROOT = join(dir, "runtime");
    process.env.WORKER_MODE = "disabled";
    process.env.EMAIL_PROVIDER = "noop";
    process.env.PLAN_TEST_LIMIT = "20";
    process.env.JOB_MAX_QUEUED_PER_USER = "10";
    // AI is optional by design: this suite runs with it fully disabled and
    // still expects complete, deterministic results.
    process.env.AI_PROVIDER = "disabled";
    process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? "warn";
    setLogLevel((process.env.E2E_LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "warn");
    resetConfigCache();
    setStorageForTests(createStorageProvider("local", join(dir, "storage")));
  });

  afterAll(() => {
    setBrowserHealthForTests(null);
    closeDb();
    setStorageForTests(null);
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    containersBefore = await listSandboxContainers();
    sandboxManager = new SandboxManager(createDockerDriver(image));
    worker = new JobWorker({ workerId: `e2e-p9-${process.pid}`, concurrency: 2, pollIntervalMs: 50, leaseMs: 30_000, jobTimeoutMs: 6 * 60_000, shutdownGraceMs: 30_000 });
    worker.register(createAutomatedTestHandler({ sandboxManager, maxConcurrentRuns: 3 }));
  });

  afterEach(async () => {
    await worker.stop();
    const after = await listSandboxContainers();
    const leaked = after.filter((id) => !containersBefore.includes(id));
    for (const id of leaked) await execFileAsync(dockerBin, ["rm", "-f", id]).catch(() => undefined);
    expect(leaked, "sandbox containers leaked").toEqual([]);
  });

  /** Drains every job currently queued (bounded), one tick per job. */
  async function drainJobs(limit = 6): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      const processed = await worker.tick();
      if (!processed) break;
    }
  }

  it.skipIf(!crossBrowserReady)(
    "runs a real browser matrix: one disposable container per browser, exact versions, honest comparison",
    async () => {
      // AI is disabled in this environment; the matrix runs fully without it
      // and no AI field may appear in the stored comparison or report.
      expect(getConfig().ai.provider).toBe("disabled");
      const user = createUser({ email: `matrix-${Date.now()}@example.com`, passwordHash: "x".repeat(60), name: "Matrix" });
      activatePlan(user.id, "pro");
      const bytes = await zipDirectory(join(fixtures, "basic-extension"));
      const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "matrix.zip" });

      const created = await createMatrixRun({
        userId: user.id,
        packageId: stored.package.id,
        extensionId: stored.package.extensionId,
        analysis: stored.analysis,
        browsers: availableBrowsers,
        suiteId: "core",
      });
      expect(created.executions).toHaveLength(availableBrowsers.length);

      await drainJobs(availableBrowsers.length + 2);

      const matrix = getMatrixRunById(created.matrixRunId)!;
      expect(["completed", "partial", "cancelled"]).toContain(matrix.status);
      expect(matrix.status).not.toBe("failed");

      const executions = listExecutionsForMatrix(created.matrixRunId);
      expect(executions).toHaveLength(availableBrowsers.length);
      for (const execution of executions) {
        expect(["completed", "failed"]).toContain(execution.status);
        // The exact version of the browser that actually executed is recorded.
        expect(execution.browser_version, `${execution.browser_id} version`).toMatch(/[0-9]/);
        const run = getTestRunById(execution.test_run_id)!;
        expect(FINAL).toContain(run.status);
        expect(run.outcome).not.toBe("INFRASTRUCTURE_ERROR");
      }

      // Documented quota policy: N browsers = N test-run units, exactly once.
      expect(countUsageThisMonth(user.id, "test_run")).toBe(availableBrowsers.length);

      // Deterministic comparison stored; cross-browser report written once.
      expect(matrix.compatibility_score).not.toBeNull();
      expect(matrix.report_id).not.toBeNull();
      const report = getReportById(matrix.report_id!)!;
      const payload = JSON.parse(report.report_json) as { kind: string; browsers: Array<{ browserId: string }>; compatibility: { coverage: number } };
      expect(payload.kind).toBe("cross-browser-matrix");
      expect(payload.browsers.map((browser) => browser.browserId).sort()).toEqual([...availableBrowsers].sort());
      expect(JSON.stringify(payload)).not.toMatch(/"ai"|containerId|docker|\/tmp\//i);

      const view = getMatrixRunView(user.id, created.matrixRunId)!;
      expect(view.comparison!.compatibility.coverage).toBe(1);
      expect(view.comparison!.compatibility.browsersUnavailable).toEqual([]);

      // Sandbox source directories were cleaned per child execution.
      expect(readdirSync(join(dir, "runtime"), { withFileTypes: true }).filter((entry) => entry.isDirectory())).toEqual([]);
    },
    8 * 60_000,
  );

  it.skipIf(!crossBrowserReady || missingBrowsers.length === 0)(
    "fails closed with BROWSER_RUNTIME_UNAVAILABLE when a browser image is missing",
    async () => {
      const user = createUser({ email: `missing-${Date.now()}@example.com`, passwordHash: "x".repeat(60), name: "Missing" });
      activatePlan(user.id, "business");
      const bytes = await zipDirectory(join(fixtures, "basic-extension"));
      const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "missing.zip" });

      const error = await createMatrixRun({
        userId: user.id,
        packageId: stored.package.id,
        extensionId: stored.package.extensionId,
        analysis: stored.analysis,
        browsers: [missingBrowsers[0]],
        suiteId: "core",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("BROWSER_RUNTIME_UNAVAILABLE");
      // Nothing was created: no matrix, no runs, no containers.
      const rows = getDb().prepare("SELECT COUNT(*) AS n FROM browser_matrix_runs WHERE user_id = ?").get(user.id) as { n: number };
      expect(rows.n).toBe(0);
      expect(await listSandboxContainers()).toEqual(containersBefore);
    },
  );
  if (docker.available && crossBrowserReady && missingBrowsers.length === 0) {
    // eslint-disable-next-line no-console
    console.warn("[e2e] skipping 'fails closed on missing image' test: all browser images are present");
  }

  it.skipIf(!crossBrowserReady)(
    "reserves N units for N browsers and blocks atomically when quota cannot cover the matrix",
    async () => {
      process.env.PLAN_PRO_TEST_LIMIT = "1";
      resetConfigCache();
      try {
        const user = createUser({ email: `quota-${Date.now()}@example.com`, passwordHash: "x".repeat(60), name: "Quota" });
        activatePlan(user.id, "pro");
        const bytes = await zipDirectory(join(fixtures, "basic-extension"));
        const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "quota.zip" });

        const error = await createMatrixRun({
          userId: user.id,
          packageId: stored.package.id,
          extensionId: stored.package.extensionId,
          analysis: stored.analysis,
          browsers: availableBrowsers.slice(0, 2),
          suiteId: "core",
          }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("QUOTA_EXCEEDED");
        // Atomic: a rejected matrix leaves nothing behind (no half-reserved rows).
        const rows = getDb().prepare("SELECT COUNT(*) AS n FROM browser_matrix_runs WHERE user_id = ?").get(user.id) as { n: number };
        expect(rows.n).toBe(0);
        const runs = getDb().prepare("SELECT COUNT(*) AS n FROM test_runs WHERE user_id = ?").get(user.id) as { n: number };
        expect(runs.n).toBe(0);
        expect(await listSandboxContainers()).toEqual(containersBefore);
      } finally {
        delete process.env.PLAN_PRO_TEST_LIMIT;
        resetConfigCache();
      }
    },
  );

  it.skipIf(!crossBrowserReady)(
    "gates the matrix behind plan entitlements and cancels a paid matrix cleanly",
    async () => {
      const free = createUser({ email: `free-${Date.now()}@example.com`, passwordHash: "x".repeat(60), name: "Free" });
      const bytes = await zipDirectory(join(fixtures, "basic-extension"));
      const storedFree = await storeExtensionPackage({ userId: free.id, bytes, fileName: "free.zip" });
      const denied = await createMatrixRun({
        userId: free.id,
        packageId: storedFree.package.id,
        extensionId: storedFree.package.extensionId,
        analysis: storedFree.analysis,
        browsers: availableBrowsers.slice(0, 2),
        suiteId: "core",
      }).catch((caught: unknown) => caught);
      expect(denied).toBeInstanceOf(AppError);
      expect((denied as AppError).code).toBe("PAYMENT_REQUIRED");

      // The same user with an active pro subscription (entitlement service
      // only — never a client-supplied plan) can create and immediately cancel.
      activatePlan(free.id, "pro");
      const created = await createMatrixRun({
        userId: free.id,
        packageId: storedFree.package.id,
        extensionId: storedFree.package.extensionId,
        analysis: storedFree.analysis,
        browsers: availableBrowsers.slice(0, 2),
        suiteId: "core",
      });
      const view = cancelMatrixRun(free.id, created.matrixRunId);
      expect(view).not.toBeNull();
      await drainJobs(availableBrowsers.length + 2);
      const matrix = getMatrixRunById(created.matrixRunId)!;
      expect(["cancelled", "partial"]).toContain(matrix.status);
      expect(await listSandboxContainers()).toEqual(containersBefore);
    },
    8 * 60_000,
  );

  it("regression A/B: version 1.0.0 passes, 2.0.0 fails — PASS→FAIL is reported, never invented", async () => {
    const user = createUser({ email: `reg-${Date.now()}@example.com`, passwordHash: "x".repeat(60), name: "Reg" });
    activatePlan(user.id, "pro");
    const extension = createExtension({ userId: user.id, name: "E2E Regression Extension", version: "1.0.0", manifestVersion: "v3", sourceName: "a.zip", healthScore: 95 });

    const bytesA = await zipDirectory(join(fixtures, "regression-a"));
    const storedA = await storeExtensionPackage({ userId: user.id, bytes: bytesA, fileName: "regression-a.zip", extensionId: extension.id });
    const runA = createQueuedTestRun({ userId: user.id, packageId: storedA.package.id, analysis: storedA.analysis, extensionId: extension.id });
    await drainJobs(2);
    const finishedA = getTestRunById(runA.runId)!;
    expect(finishedA.status).toBe("completed");
    const resultsA = parseResults(finishedA).results;
    const consoleA = resultsA.find((result) => result.testId === "console-runtime-errors");
    // Honest fixture check: version A must genuinely pass the console test.
    expect(consoleA, "fixture A must include the console test").toBeDefined();
    expect(consoleA!.status, `fixture A console test passed (got: ${JSON.stringify(resultsA.map((r) => [r.testId, r.status]))})`).toBe("passed");

    const baseline = setBaseline({
      userId: user.id,
      extensionId: extension.id,
      packageId: storedA.package.id,
      testSuiteId: "core",
      browsers: ["chromium"],
      runId: runA.runId,
      score: finishedA.score,
    });
    expect(baseline.run_id).toBe(runA.runId);

    const bytesB = await zipDirectory(join(fixtures, "regression-b"));
    const storedB = await storeExtensionPackage({ userId: user.id, bytes: bytesB, fileName: "regression-b.zip", extensionId: extension.id });
    const runB = createQueuedTestRun({ userId: user.id, packageId: storedB.package.id, analysis: storedB.analysis, extensionId: extension.id });
    await drainJobs(2);
    const finishedB = getTestRunById(runB.runId)!;
    expect(finishedB.status).toBe("completed");
    const resultsB = parseResults(finishedB).results;
    const consoleB = resultsB.find((result) => result.testId === "console-runtime-errors");
    // Honest fixture check: version B must genuinely fail it in the real browser.
    expect(consoleB, "fixture B must include the console test").toBeDefined();
    expect(consoleB!.status, "fixture B console test failed").toBe("failed");

    const { result } = compareForRegression({ userId: user.id, previous: { runId: runA.runId }, current: { runId: runB.runId } });
    const chromium = result.browsers.find((browser) => browser.browserId === "chromium")!;
    expect(chromium.executed).toEqual({ previous: true, current: true });
    const regression = chromium.regressions.find((entry) => entry.testId === "console-runtime-errors");
    expect(regression).toBeDefined();
    expect(regression).toMatchObject({ from: "passed", to: "failed" });
    expect(result.aggregate.insufficientData).toBe(false);
    // The comparison pins both package versions for traceability.
    expect(result.previous.packageVersion).toBe("1.0.0");
    expect(result.current.packageVersion).toBe("2.0.0");
  }, 8 * 60_000);
});

describe("cross-browser Docker E2E environment", () => {
  it("reports whether the cross-browser suite ran, and why not", () => {
    // Makes the skip visible in every report instead of silently passing.
    expect(typeof docker.available).toBe("boolean");
    if (!docker.available) expect(docker.reason.length).toBeGreaterThan(0);
    if (docker.available && !crossBrowserReady) {
      expect(missingBrowsers.length).toBeGreaterThan(0);
    }
  });
});
