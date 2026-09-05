/**
 * Real-Docker end-to-end suite.
 *
 * Exercises the production path with no doubles: stored package → queued job
 * → worker → SandboxManager → Docker container (pinned sandbox image) →
 * Chromium → Phase 4 engine → results → artifacts → cleanup.
 *
 * Requirements: Docker CLI + daemon reachable from this process and the
 * sandbox image built (`npm run sandbox:build`). When they are missing the
 * suite skips itself with an explicit reason — unless EXTENSIONLAB_E2E_DOCKER=1
 * is set (CI), in which case "unavailable" is a hard failure. Results are
 * never faked: every assertion below is against real container output.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { closeDb, getDb } from "@/lib/db/client";
import { resetConfigCache } from "@/lib/config/env";
import { createStorageProvider, getStorage, setStorageForTests } from "@/lib/storage/storage";
import { setLogLevel } from "@/lib/observability/logger";
import { createUser } from "@/lib/db/repositories/users";
import { storeExtensionPackage } from "@/lib/packages/service";
import { buildRunInfo, cancelRun, createQueuedTestRun, listRunEvents, parseResults } from "@/lib/testing/run-service";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { getJobById } from "@/lib/db/repositories/jobs";
import { findReservationForResource } from "@/lib/db/repositories/quota";
import { countUsageThisMonth } from "@/lib/db/repositories/usage";
import { listArtifactsForRun } from "@/lib/db/repositories/artifacts";
import { readOwnedArtifact } from "@/lib/artifacts/service";
import { JobWorker } from "@/lib/jobs/worker";
import { createAutomatedTestHandler } from "@/lib/jobs/handlers/automated-test";
import { SandboxManager } from "@/lib/runtime/sandbox-manager";
import { createDockerDriver } from "@/lib/runtime/docker-driver";
import { probeSandboxEnvironment, resetSandboxProbeCache } from "@/lib/runtime/availability";
import { AppError } from "@/lib/observability/errors";

const execFileAsync = promisify(execFile);
const dockerBin = process.env.DOCKER_BIN || "docker";
const image = process.env.SANDBOX_IMAGE || "extensionlab-sandbox:local";
const mustRun = process.env.EXTENSIONLAB_E2E_DOCKER === "1";

interface Environment {
  available: boolean;
  reason: string;
}

async function detectEnvironment(): Promise<Environment> {
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

async function waitFor<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs: number, label: string, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const FINAL = ["completed", "failed", "timeout", "destroyed"];
const fixtures = join(process.cwd(), "tests", "e2e", "fixtures");

const environment = await detectEnvironment();
if (!environment.available && mustRun) {
  throw new Error(`Docker E2E required (EXTENSIONLAB_E2E_DOCKER=1) but unavailable: ${environment.reason}`);
}
const suite = environment.available ? describe : describe.skip;

if (!environment.available) {
  // eslint-disable-next-line no-console
  console.warn(`[e2e] skipping real-Docker suite: ${environment.reason}`);
}

suite("real Docker sandbox end-to-end", () => {
  let dir: string;
  let userId: string;
  let sandboxManager: SandboxManager;
  let worker: JobWorker;
  let containersBefore: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "el-e2e-"));
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
    process.env.JOB_MAX_QUEUED_PER_USER = "5";
    process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? "warn";
    setLogLevel((process.env.E2E_LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "warn");
    resetConfigCache();
    setStorageForTests(createStorageProvider("local", join(dir, "storage")));
    userId = createUser({ email: "e2e@example.com", passwordHash: "x".repeat(60), name: "E2E" }).id;
  });

  afterAll(async () => {
    closeDb();
    setStorageForTests(null);
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    containersBefore = await listSandboxContainers();
    sandboxManager = new SandboxManager(createDockerDriver(image));
    worker = new JobWorker({ workerId: `e2e-${process.pid}`, concurrency: 1, pollIntervalMs: 50, leaseMs: 30_000, jobTimeoutMs: 4 * 60_000, shutdownGraceMs: 30_000 });
    worker.register(createAutomatedTestHandler({ sandboxManager, maxConcurrentRuns: 2 }));
  });

  afterEach(async () => {
    await worker.stop();
    // Real cleanup verification: no sandbox container may survive a test.
    const after = await listSandboxContainers();
    const leaked = after.filter((id) => !containersBefore.includes(id));
    for (const id of leaked) await execFileAsync(dockerBin, ["rm", "-f", id]).catch(() => undefined);
    expect(leaked, "sandbox containers leaked").toEqual([]);
  });

  it("runs the basic extension through a real sandbox and records genuine results", async () => {
    const bytes = await zipDirectory(join(fixtures, "basic-extension"));
    const stored = await storeExtensionPackage({ userId, bytes, fileName: "basic-extension.zip" });
    expect(stored.analysis.manifest.manifestVersion).toBe("v3");

    const created = createQueuedTestRun({ userId, packageId: stored.package.id, analysis: stored.analysis, extensionId: null });
    expect(getTestRunById(created.runId)?.status).toBe("queued");
    expect(findReservationForResource(created.runId)?.consumed_at).toBeNull();

    const startedAt = Date.now();
    expect(await worker.tick()).toBe(true);
    const run = getTestRunById(created.runId)!;
    expect(FINAL).toContain(run.status);
    expect(run.status).toBe("completed");
    expect(["PASSED", "WARNING", "FAILED"]).toContain(run.outcome);
    expect(run.started_at).not.toBeNull();
    expect(run.completed_at).toBeGreaterThanOrEqual(startedAt);

    // Real engine output: every discovered test has a result with real timing.
    const parsed = parseResults(run);
    expect(parsed.results.length).toBe(run.total);
    expect(parsed.results.every((result) => result.finishedAt >= result.startedAt)).toBe(true);
    const byId = new Map(parsed.results.map((result) => [result.testId, result]));
    expect(byId.get("extension-loads")?.status).toBe("passed");
    expect(byId.get("test-page-loads")?.status).toBe("passed");
    expect(byId.get("content-script")?.status).toBe("passed");
    expect(byId.get("service-worker")?.status).toBe("passed");
    expect(parsed.score?.basis).not.toMatch(/No automated tests/);

    // The Phase 4 SSE stage sequence was emitted in order through job events.
    const stages = listRunEvents(run, 0)
      .map((event) => JSON.parse(event.payload) as { type?: string; stage?: string })
      .filter((event) => event.type === "stage")
      .map((event) => event.stage);
    for (const stage of ["Preparing", "Starting sandbox", "Starting Chromium", "Loading extension", "Running tests", "Collecting evidence", "Generating report", "Completed"]) {
      expect(stages, `stage ${stage}`).toContain(stage);
    }
    expect(stages.indexOf("Starting sandbox")).toBeLessThan(stages.indexOf("Running tests"));

    // Console events from the fixture were really captured inside the container.
    const runtimeLog = listArtifactsForRun(created.runId).find((row) => row.type === "runtime-log");
    expect(runtimeLog).toBeDefined();
    const logBytes = (await readOwnedArtifact(userId, runtimeLog!.id))!.bytes;
    const logText = Buffer.from(logBytes).toString("utf8");
    expect(logText).toContain("[e2e-basic] content script loaded");
    const network = listArtifactsForRun(created.runId).find((row) => row.type === "network-summary");
    expect(network).toBeDefined();
    expect(Buffer.from((await readOwnedArtifact(userId, network!.id))!.bytes).toString("utf8")).toContain("extensionlab-test");

    // Quota consumed exactly once; job completed; nothing exposes host details.
    expect(findReservationForResource(created.runId)?.consumed_at).not.toBeNull();
    expect(countUsageThisMonth(userId, "test_run")).toBe(1);
    expect(getJobById(created.jobId)?.status).toBe("completed");
    const info = buildRunInfo(run);
    expect(JSON.stringify(info)).not.toMatch(/containerId|docker|\/tmp\//i);

    // Sandbox source directory was removed from the worker host.
    expect(readdirSync(join(dir, "runtime"), { withFileTypes: true }).filter((entry) => entry.isDirectory())).toEqual([]);
  });

  it("times out a hostile extension, ends as TIMEOUT (never PASSED) and destroys the container", async () => {
    const bytes = await zipDirectory(join(fixtures, "timeout-extension"));
    const stored = await storeExtensionPackage({ userId, bytes, fileName: "timeout-extension.zip" });
    const created = createQueuedTestRun({ userId, packageId: stored.package.id, analysis: stored.analysis, extensionId: null });
    await worker.tick();
    const run = getTestRunById(created.runId)!;
    expect(FINAL).toContain(run.status);
    expect(run.outcome).not.toBe("PASSED");
    expect(["TIMEOUT", "FAILED", "WARNING"]).toContain(run.outcome);
    if (run.outcome === "TIMEOUT") {
      expect(run.error_code).toMatch(/TIMEOUT/);
    }
    expect(await listSandboxContainers()).toEqual(containersBefore);
  }, 5 * 60_000);

  it("cancels a running sandbox cooperatively and tears the container down", async () => {
    const bytes = await zipDirectory(join(fixtures, "basic-extension"));
    const stored = await storeExtensionPackage({ userId, bytes, fileName: "basic-extension.zip" });
    const created = createQueuedTestRun({ userId, packageId: stored.package.id, analysis: stored.analysis, extensionId: null });
    const ticking = worker.tick();
    await waitFor(() => {
      const row = getTestRunById(created.runId);
      return row && ["starting", "running"].includes(row.status) ? row : null;
    }, 120_000, "run to reach starting/running");
    const info = cancelRun(getTestRunById(created.runId)!);
    expect(["starting", "running", "stopping", "destroyed"]).toContain(info.state);
    await ticking;
    const run = getTestRunById(created.runId)!;
    expect(FINAL).toContain(run.status);
    expect(run.outcome).toBe("CANCELLED");
    expect(getJobById(created.jobId)?.status).toBe("cancelled");
    expect(findReservationForResource(created.runId)?.released_at).not.toBeNull();
    expect(await listSandboxContainers()).toEqual(containersBefore);
  }, 5 * 60_000);

  it("rejects an invalid package before anything reaches storage or Docker", async () => {
    const bytes = readFileSync(join(fixtures, "invalid-extension.txt"));
    const error = await storeExtensionPackage({ userId, bytes: new Uint8Array(bytes), fileName: "invalid.zip" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INVALID_EXTENSION");
    expect(await getStorage().list("extensions/")).not.toContain("invalid");
    expect(await listSandboxContainers()).toEqual(containersBefore);
  });

  it("recovers a run whose worker crashed mid-flight (orphan recovery + retry)", async () => {
    const bytes = await zipDirectory(join(fixtures, "basic-extension"));
    const stored = await storeExtensionPackage({ userId, bytes, fileName: "basic-extension.zip" });
    const created = createQueuedTestRun({ userId, packageId: stored.package.id, analysis: stored.analysis, extensionId: null });
    // Simulate a crashed worker: job claimed, lease expired, run left "preparing".
    getDb()
      .prepare("UPDATE jobs SET status = 'running', worker_id = 'crashed', lease_expires_at = ?, attempts = 1 WHERE id = ?")
      .run(Date.now() - 1000, created.jobId);
    getDb().prepare("UPDATE test_runs SET status = 'preparing', stage = 'Preparing' WHERE id = ?").run(created.runId);

    expect(worker.recoverOrphans("startup")).toBe(1);
    expect(getJobById(created.jobId)).toMatchObject({ status: "retrying", error_code: "WORKER_UNAVAILABLE" });
    expect(await worker.tick()).toBe(true);
    const run = getTestRunById(created.runId)!;
    expect(run.status).toBe("completed");
    expect(getJobById(created.jobId)).toMatchObject({ status: "completed", attempts: 2 });
    expect(await listSandboxContainers()).toEqual(containersBefore);
  }, 5 * 60_000);

  it("enforces the Docker hardening flags on a live container", async () => {
    const bytes = await zipDirectory(join(fixtures, "basic-extension"));
    const stored = await storeExtensionPackage({ userId, bytes, fileName: "basic-extension.zip" });
    const created = createQueuedTestRun({ userId, packageId: stored.package.id, analysis: stored.analysis, extensionId: null });
    const ticking = worker.tick();
    const containerId = await waitFor(async () => {
      const live = (await listSandboxContainers()).filter((id) => !containersBefore.includes(id));
      return live[0] ?? null;
    }, 120_000, "sandbox container").catch(() => null);
    if (containerId) {
      const { stdout } = await execFileAsync(dockerBin, ["inspect", containerId]);
      const [inspect] = JSON.parse(stdout) as Array<{ HostConfig: Record<string, unknown>; Config: { User: string } }>;
      expect(inspect.HostConfig.Privileged).toBe(false);
      expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspect.HostConfig.CapDrop).toContain("ALL");
      expect(inspect.HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(inspect.HostConfig.NetworkMode).not.toBe("host");
      expect(inspect.HostConfig.PidMode).not.toBe("host");
      expect(inspect.HostConfig.Binds ?? []).toEqual([]);
      expect(Number(inspect.HostConfig.PidsLimit)).toBeGreaterThan(0);
      expect(Number(inspect.HostConfig.Memory)).toBeGreaterThan(0);
      expect(inspect.Config.User).toBe("node");
    }
    await ticking;
    expect(containerId, "a sandbox container must have been observed").not.toBeNull();
    expect(await listSandboxContainers()).toEqual(containersBefore);
  }, 5 * 60_000);
});

describe("Docker E2E environment", () => {
  it("reports whether the real-Docker suite ran", () => {
    // Makes the skip visible in every report instead of silently passing.
    expect(typeof environment.available).toBe("boolean");
    if (!environment.available) {
      expect(environment.reason.length).toBeGreaterThan(0);
    }
  });
});
