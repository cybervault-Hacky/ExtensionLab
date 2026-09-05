import { afterEach, beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { getDb } from "@/lib/db/client";
import { JobWorker } from "@/lib/jobs/worker";
import { createAutomatedTestHandler } from "@/lib/jobs/handlers/automated-test";
import { storeExtensionPackage } from "@/lib/packages/service";
import { buildRunInfo, cancelRun, createQueuedTestRun, listRunEvents, parseResults, resolveAccessibleRun } from "@/lib/testing/run-service";
import { getJobById } from "@/lib/db/repositories/jobs";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { countOpenReservations, findReservationForResource, getQuotaSnapshot } from "@/lib/db/repositories/quota";
import { countUsageThisMonth } from "@/lib/db/repositories/usage";
import { listArtifactsForRun } from "@/lib/db/repositories/artifacts";
import { listOwnedRunArtifacts, readOwnedArtifact } from "@/lib/artifacts/service";
import { getStorage } from "@/lib/storage/storage";
import type { SandboxManager } from "@/lib/runtime/sandbox-manager";
import type { SandboxProbeResult } from "@/lib/runtime/availability";
import type { CreateSandboxResponse, NetworkEntry, RuntimeEvent, SandboxInfo } from "@/types/runtime";
import type { TestAction } from "@/lib/testing/types";
import { SandboxRuntimeError } from "@/lib/runtime/errors";
import { setupHarness, makeUser, type Harness } from "./helpers";

const manifest = JSON.stringify({
  manifest_version: 3,
  name: "Pipeline Fixture",
  version: "1.0.0",
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
});

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", manifest);
  zip.file("background.js", "console.log('sw');");
  zip.file("content.js", "console.log('content script loaded');");
  return zip.generateAsync({ type: "uint8array" });
}

/** Deterministic stand-in for the Docker SandboxManager (Phase 4 test double). */
class FakeSandboxManager {
  created = 0;
  stopped = 0;
  failCreateWith: Error | null = null;

  async create(): Promise<CreateSandboxResponse> {
    this.created += 1;
    if (this.failCreateWith) throw this.failCreateWith;
    return { sandboxId: `sandbox_fake_${this.created}`, sessionToken: "tok", referenceId: "ref", status: "preparing" };
  }
  async start(): Promise<SandboxInfo> {
    return { sandboxId: "sandbox_fake", status: "running", browser: { product: "Chromium", version: "test", state: "running" }, createdAt: Date.now(), referenceId: "ref" };
  }
  async stop(): Promise<SandboxInfo> {
    this.stopped += 1;
    return { sandboxId: "sandbox_fake", status: "destroyed", browser: { product: "Chromium", version: "test", state: "stopped" }, createdAt: Date.now(), referenceId: "ref" };
  }
  async executeTestAction(_id: string, _token: string, action: TestAction): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
    if (action.type === "open_popup") return { ok: false };
    if (action.type === "inspect_element") return { ok: true, data: { exists: true, visible: true, text: "status text" } };
    if (action.type === "inspect_text") return { ok: true, data: { text: "status text" } };
    return { ok: true };
  }
  getEvents(): RuntimeEvent[] {
    return [
      { id: "a", timestamp: Date.now(), type: "extension", level: "info", source: "extension", message: "Extension loaded. Service worker registered." },
      { id: "b", timestamp: Date.now(), type: "console", level: "log", source: "content.js", message: "content script loaded" },
      { id: "c", timestamp: Date.now(), type: "page", level: "info", source: "page", message: "Page loaded." },
    ];
  }
  getNetwork(): NetworkEntry[] {
    return [{ id: "n", timestamp: Date.now(), method: "GET", url: "http://127.0.0.1:8080/extensionlab-test", status: 200, resourceType: "document", duration: 1 }];
  }
  async screenshot(): Promise<Uint8Array | null> {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  }
}

function makeWorker(sandbox: FakeSandboxManager, probe: () => Promise<SandboxProbeResult>): JobWorker {
  const worker = new JobWorker({ workerId: "w-pipeline", concurrency: 1, pollIntervalMs: 10, leaseMs: 10_000, jobTimeoutMs: 20_000 });
  worker.register(
    createAutomatedTestHandler({ sandboxManager: sandbox as unknown as SandboxManager, maxConcurrentRuns: 2, sandboxProbe: probe }),
  );
  return worker;
}

const available = async (): Promise<SandboxProbeResult> => ({ available: true });

describe("test run pipeline (package → job → worker → engine → results)", () => {
  let harness: Harness;
  let userId: string;
  let packageId: string;
  let analysis: Awaited<ReturnType<typeof storeExtensionPackage>>["analysis"];

  beforeEach(async () => {
    harness = setupHarness({ PLAN_TEST_LIMIT: "2", PLAN_MAX_CONCURRENT_RUNS: "2", JOB_MAX_QUEUED_PER_USER: "2" });
    userId = makeUser().id;
    const stored = await storeExtensionPackage({ userId, bytes: await fixtureZip(), fileName: "fixture.zip" });
    packageId = stored.package.id;
    analysis = stored.analysis;
  });
  afterEach(() => harness.teardown());

  it("creates a queued run with an atomic quota reservation and does not block on execution", () => {
    const before = getQuotaSnapshot(userId, "test_run");
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    expect(created.runId).toMatch(/^run_/);
    expect(created.jobId).toMatch(/^job_/);
    expect(created.token.length).toBeGreaterThanOrEqual(32);
    expect(created.suite.total).toBeGreaterThan(0);

    const run = getTestRunById(created.runId)!;
    expect(run.status).toBe("queued");
    expect(run.stage).toBe("Queued");
    expect(run.package_id).toBe(packageId);
    expect(run.job_id).toBe(created.jobId);
    expect(run.access_token_hash).not.toBe(created.token);
    expect(getJobById(created.jobId)?.status).toBe("queued");

    const after = getQuotaSnapshot(userId, "test_run");
    expect(after.reserved).toBe(before.reserved + 1);
    expect(after.remaining).toBe(before.remaining - 1);
    expect(countUsageThisMonth(userId, "test_run")).toBe(0);

    const info = buildRunInfo(run);
    expect(info).toMatchObject({ runId: created.runId, state: "queued", stage: "Queued", jobId: created.jobId, queuePosition: 1 });
    expect(info.outcome).toBeUndefined();
    expect(info.completed).toBe(0);
  });

  it("rejects new runs once quota is exhausted by reservations and rolls back atomically", () => {
    createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    const runsBefore = (getDb().prepare("SELECT COUNT(*) AS n FROM test_runs").get() as { n: number }).n;
    const jobsBefore = (getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
    expect(() => createQueuedTestRun({ userId, packageId, analysis, extensionId: null })).toThrow();
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM test_runs").get() as { n: number }).n).toBe(runsBefore);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(jobsBefore);
    expect(countOpenReservations(userId, "test_run")).toBe(2);
  });

  it("executes the run through the engine, persists results, artifacts and consumes quota", async () => {
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    const sandbox = new FakeSandboxManager();
    const worker = makeWorker(sandbox, available);
    expect(await worker.tick()).toBe(true);

    const run = getTestRunById(created.runId)!;
    expect(run.status).toBe("completed");
    expect(["PASSED", "FAILED", "WARNING"]).toContain(run.outcome);
    expect(run.stage).toBe("Completed");
    expect(run.score).not.toBeNull();
    expect(run.completed_at).not.toBeNull();
    const parsed = parseResults(run);
    expect(parsed.results.length).toBe(run.total);
    expect(parsed.score?.basis).not.toMatch(/No automated tests/);

    const job = getJobById(created.jobId)!;
    expect(job.status).toBe("completed");
    expect(sandbox.created).toBe(1);
    expect(sandbox.stopped).toBeGreaterThanOrEqual(1);

    // Quota: reservation consumed exactly once, usage recorded once.
    expect(findReservationForResource(created.runId)?.consumed_at).not.toBeNull();
    expect(countOpenReservations(userId, "test_run")).toBe(0);
    expect(countUsageThisMonth(userId, "test_run")).toBe(1);

    // Artifacts: private, owner-scoped, stored behind opaque keys.
    const rows = listArtifactsForRun(created.runId);
    expect(rows.length).toBeGreaterThan(0);
    const types = new Set(rows.map((row) => row.type));
    expect(types.has("runtime-log")).toBe(true);
    expect(types.has("network-summary")).toBe(true);
    for (const row of rows) {
      expect(row.storage_key).toMatch(/^artifacts\//);
      expect(row.sha256).toHaveLength(64);
      expect(row.expires_at).toBeGreaterThan(Date.now());
      expect(await getStorage().exists(row.storage_key)).toBe(true);
    }
    const summaries = listOwnedRunArtifacts(userId, created.runId);
    expect(JSON.stringify(summaries)).not.toContain("artifacts/");
    expect(listOwnedRunArtifacts(makeUser().id, created.runId)).toEqual([]);
    const readable = await readOwnedArtifact(userId, rows[0].id);
    expect(readable?.bytes.byteLength).toBe(rows[0].size);
    expect(await readOwnedArtifact(makeUser().id, rows[0].id)).toBeNull();
    // Expired artifacts are inaccessible even to the owner (retention is enforced on read, not only on cleanup).
    getDb().prepare("UPDATE artifacts SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, rows[0].id);
    expect(await readOwnedArtifact(userId, rows[0].id)).toBeNull();
    expect(listOwnedRunArtifacts(userId, created.runId).some((artifact) => artifact.id === rows[0].id)).toBe(false);

    // Live event stream contains the Phase 4 stages in order and a terminal event.
    const stages = listRunEvents(run, 0)
      .map((event) => JSON.parse(event.payload) as { type?: string; stage?: string })
      .filter((event) => event.type === "stage")
      .map((event) => event.stage);
    expect(stages[0]).toBe("Preparing");
    expect(stages).toContain("Running tests");
    expect(stages[stages.length - 1]).toBe("Completed");
    const info = buildRunInfo(getTestRunById(created.runId)!);
    expect(info.state).toBe("completed");
    expect(info.completed).toBe(run.total);
  });

  it("never fabricates results when the sandbox environment is unavailable (permanent)", async () => {
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    const sandbox = new FakeSandboxManager();
    const worker = makeWorker(sandbox, async () => ({ available: false, reason: "docker_missing" }));
    await worker.tick();

    const run = getTestRunById(created.runId)!;
    expect(run.status).toBe("failed");
    expect(run.outcome).toBe("INFRASTRUCTURE_ERROR");
    expect(run.error_code).toBe("SANDBOX_UNAVAILABLE");
    expect(run.passed).toBe(0);
    expect(run.total).toBeGreaterThan(0);
    expect(run.result_json).toBeNull();
    expect(sandbox.created).toBe(0);
    const job = getJobById(created.jobId)!;
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.error_code).toBe("SANDBOX_UNAVAILABLE");
    // Failed sandbox starts do not consume quota.
    expect(findReservationForResource(created.runId)?.released_at).not.toBeNull();
    expect(countUsageThisMonth(userId, "test_run")).toBe(0);
    const info = buildRunInfo(run);
    expect(info.outcome).toBe("INFRASTRUCTURE_ERROR");
    expect(info.reason).toMatch(/isolated browser environment/);
    expect(JSON.stringify(info)).not.toMatch(/docker|container|\/tmp\//i);
  });

  it("retries transient sandbox failures with backoff and keeps the reservation open", async () => {
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    const sandbox = new FakeSandboxManager();
    let probes = 0;
    const worker = makeWorker(sandbox, async () => {
      probes += 1;
      return probes === 1 ? { available: false, reason: "docker_unreachable" } : { available: true };
    });

    await worker.tick();
    let run = getTestRunById(created.runId)!;
    let job = getJobById(created.jobId)!;
    expect(job.status).toBe("retrying");
    expect(job.attempts).toBe(1);
    expect(job.error_code).toBe("SANDBOX_UNAVAILABLE");
    expect(run.status).toBe("queued");
    expect(findReservationForResource(created.runId)?.released_at).toBeNull();
    expect(buildRunInfo(run).state).toBe("queued");

    getDb().prepare("UPDATE jobs SET run_after = ? WHERE id = ?").run(Date.now() - 1, job.id);
    await worker.tick();
    run = getTestRunById(created.runId)!;
    job = getJobById(created.jobId)!;
    expect(job.status).toBe("completed");
    expect(job.attempts).toBe(2);
    expect(run.status).toBe("completed");
    expect(countUsageThisMonth(userId, "test_run")).toBe(1);
  });

  it("fails permanently after the retry budget is exhausted", async () => {
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    getDb().prepare("UPDATE jobs SET max_attempts = 2 WHERE id = ?").run(created.jobId);
    const sandbox = new FakeSandboxManager();
    const worker = makeWorker(sandbox, async () => ({ available: false, reason: "image_missing" }));
    await worker.tick();
    expect(getJobById(created.jobId)?.status).toBe("retrying");
    getDb().prepare("UPDATE jobs SET run_after = ? WHERE id = ?").run(Date.now() - 1, created.jobId);
    await worker.tick();
    const job = getJobById(created.jobId)!;
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(2);
    const run = getTestRunById(created.runId)!;
    expect(run.status).toBe("failed");
    expect(run.outcome).toBe("INFRASTRUCTURE_ERROR");
    expect(findReservationForResource(created.runId)?.released_at).not.toBeNull();
    expect(countUsageThisMonth(userId, "test_run")).toBe(0);
    // A duplicated job for the same finished run must not report success.
    expect(await worker.tick()).toBe(false);
  });

  it("maps sandbox creation failures to infrastructure errors without touching quota", async () => {
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    getDb().prepare("UPDATE jobs SET max_attempts = 1 WHERE id = ?").run(created.jobId);
    const sandbox = new FakeSandboxManager();
    sandbox.failCreateWith = new SandboxRuntimeError("environment_unavailable", "Docker daemon is not reachable at /var/run/docker.sock", "ERR-TEST");
    const worker = makeWorker(sandbox, available);
    await worker.tick();
    const run = getTestRunById(created.runId)!;
    expect(run.status).toBe("failed");
    expect(run.outcome).toBe("INFRASTRUCTURE_ERROR");
    expect(run.error_code).toBe("SANDBOX_UNAVAILABLE");
    expect(run.reason ?? "").not.toMatch(/docker\.sock|\/var\/run/);
    expect(countUsageThisMonth(userId, "test_run")).toBe(0);
    expect(findReservationForResource(created.runId)?.released_at).not.toBeNull();
  });

  it("cancels a queued run idempotently and releases its reservation", () => {
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    const run = getTestRunById(created.runId)!;
    const first = cancelRun(run);
    expect(first.state).toBe("destroyed");
    expect(first.outcome).toBe("CANCELLED");
    expect(getJobById(created.jobId)?.status).toBe("cancelled");
    expect(findReservationForResource(created.runId)?.released_at).not.toBeNull();
    expect(countOpenReservations(userId, "test_run")).toBe(0);
    const second = cancelRun(getTestRunById(created.runId)!);
    expect(second.state).toBe("destroyed");
    expect(second.outcome).toBe("CANCELLED");
  });

  it("marks a running run as stopping and lets the worker finish the cancellation", async () => {
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    const sandbox = new FakeSandboxManager();
    // Delay the probe so we can cancel while the job is running.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = makeWorker(sandbox, async () => {
      await gate;
      return { available: true };
    });
    const ticking = worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const info = cancelRun(getTestRunById(created.runId)!);
    expect(["preparing", "stopping", "destroyed"]).toContain(info.state);
    release!();
    await ticking;
    const run = getTestRunById(created.runId)!;
    expect(run.status).toBe("destroyed");
    expect(run.outcome).toBe("CANCELLED");
    expect(getJobById(created.jobId)?.status).toBe("cancelled");
    expect(countUsageThisMonth(userId, "test_run")).toBe(0);
    expect(findReservationForResource(created.runId)?.released_at).not.toBeNull();
  });

  it("grants live access to the owner or a valid run token only", () => {
    const created = createQueuedTestRun({ userId, packageId, analysis, extensionId: null });
    const stranger = makeUser().id;
    expect(resolveAccessibleRun(userId, created.runId, null).id).toBe(created.runId);
    expect(resolveAccessibleRun(stranger, created.runId, created.token).id).toBe(created.runId);
    expect(() => resolveAccessibleRun(stranger, created.runId, null)).toThrow(/not found/i);
    expect(() => resolveAccessibleRun(stranger, created.runId, "wrong-token-wrong-token-wrong")).toThrow(/not found/i);
    expect(() => resolveAccessibleRun(userId, "run_missing", null)).toThrow(/not found/i);
  });
});
