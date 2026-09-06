/**
 * Phase 15 real-infrastructure e2e: Test Automation Studio CI journey.
 *
 * EXTENSIONLAB_E2E_DOCKER=1 runs the full pipeline against a real Docker
 * sandbox: upload package → save + activate a studio test → trigger via the
 * v1 API (API key, org-scoped, Idempotency-Key) → worker executes in a real
 * fresh browser → poll the CI status → real per-test results, recorded under
 * the saved test's deterministic id. Org isolation and entitlements are
 * asserted on the same live database.
 *
 * Without the flag the suite skips with an explicit reason; with the flag and
 * missing Docker it HARD FAILS — browser execution and results are never
 * faked.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { closeDb } from "@/lib/db/client";
import { resetConfigCache } from "@/lib/config/env";
import { setStorageForTests, createStorageProvider } from "@/lib/storage/storage";
import { setLogLevel } from "@/lib/observability/logger";
import { createUser } from "@/lib/db/repositories/users";
import { probeSandboxEnvironment, resetSandboxProbeCache } from "@/lib/runtime/availability";
import { createDockerDriver } from "@/lib/runtime/docker-driver";
import { SandboxManager } from "@/lib/runtime/sandbox-manager";
import { JobWorker } from "@/lib/jobs/worker";
import { createAutomatedTestHandler } from "@/lib/jobs/handlers/automated-test";
import { storeExtensionPackage } from "@/lib/packages/service";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { parseResults } from "@/lib/testing/run-service";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { createApiKey } from "@/lib/api-keys/service";
import { POST as postRun, GET as getRun } from "@/app/api/v1/tests/[testId]/runs/route";
import { createStudioTest, updateStudioTest, type StudioViewer } from "@/lib/testing/studio-service";
import { upsertBillingCustomer, upsertSubscription } from "@/lib/db/repositories/billing";

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

function zipDirectory(dir: string): Promise<Uint8Array> {
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

const environment = await detectEnvironment();
if (!environment.available && mustRun) {
  throw new Error(`Docker E2E required (EXTENSIONLAB_E2E_DOCKER=1) but unavailable: ${environment.reason}`);
}
const suite = environment.available ? describe : describe.skip;

if (!environment.available) {
  // eslint-disable-next-line no-console
  console.warn(`[e2e] skipping Phase 15 studio suite: ${environment.reason}`);
}

const FINAL = ["completed", "failed", "timeout", "destroyed"];
const fixtures = join(process.cwd(), "tests", "e2e", "fixtures");

suite("phase15 studio: CI journey through a real browser", () => {
  let dir: string;
  let owner: { id: string };
  let orgId: string;
  let apiKey: string;
  let sandboxManager: SandboxManager;
  let worker: JobWorker;
  let containersBefore: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "el-p15-e2e-"));
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

    owner = createUser({ email: "p15-e2e@example.com", passwordHash: "x".repeat(60), name: "P15" });
    // Pro plan for the CI path (cross-tenant gates + concurrency).
    const now = Date.now();
    upsertBillingCustomer({ userId: owner.id, provider: "fake", providerCustomerId: `cust_${owner.id}` });
    upsertSubscription({
      userId: owner.id,
      provider: "fake",
      providerCustomerId: `cust_${owner.id}`,
      providerSubscriptionId: `sub_${owner.id}_pro`,
      providerPriceId: "price_pro_test",
      planId: "pro",
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
    const org = createOrganization({ userId: owner.id }, { name: "P15 E2E Co" });
    setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
    orgId = org.id;
    apiKey = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "p15-ci", scopes: ["tests:read", "tests:write"] }).key;
  });

  afterAll(() => {
    closeDb();
    setStorageForTests(null);
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    containersBefore = await listSandboxContainers();
    sandboxManager = new SandboxManager(createDockerDriver(image));
    worker = new JobWorker({ workerId: `p15-e2e-${process.pid}`, concurrency: 1, pollIntervalMs: 50, leaseMs: 30_000, jobTimeoutMs: 4 * 60_000, shutdownGraceMs: 30_000 });
    worker.register(createAutomatedTestHandler({ sandboxManager, maxConcurrentRuns: 2 }));
  });

  afterEach(async () => {
    await worker.stop();
    const after = await listSandboxContainers();
    const leaked = after.filter((id) => !containersBefore.includes(id));
    for (const id of leaked) await execFileAsync(dockerBin, ["rm", "-f", id]).catch(() => undefined);
    expect(leaked, "sandbox containers leaked").toEqual([]);
  });

  function request(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): NextRequest {
    return new NextRequest(url, { method: init.method ?? "GET", body: init.body, headers: init.headers ?? {} });
  }

  it("API trigger → queue → real browser run → honest CI result, with org isolation", async () => {
    const bytes = await zipDirectory(join(fixtures, "basic-extension"));
    const stored = await storeExtensionPackage({ userId: owner.id, organizationId: orgId, bytes, fileName: "basic-extension.zip" });
    expect(stored.analysis.manifest.manifestVersion).toBe("v3");

    // Studio: save + activate a test against the exact package bytes.
    const viewer: StudioViewer = { userId: owner.id, organizationId: orgId };
    const test = await createStudioTest(
      viewer,
      {
        name: "E2E popup journey",
        description: "Real run through the studio pipeline",
        tags: ["e2e"],
        browserTargets: ["chromium"],
        definition: {
          schemaVersion: 1,
          setup: [],
          actions: [
            { type: "open_url", url: "{{test_url}}" },
            { type: "wait", milliseconds: 400 },
          ],
          assertions: [{ type: "extension_loaded" }],
          cleanup: [],
          variables: [],
          timeoutMs: 20_000,
          category: "loading",
          severity: "high",
        },
      },
      stored.package.id,
    );
    await updateStudioTest(viewer, test.id, { status: "ACTIVE" });

    // CI trigger via the v1 API.
    const trigger = (await postRun(
      request(`https://x/api/v1/tests/${test.id}/runs`, {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": "p15-e2e-1" },
      }),
      { params: Promise.resolve({ testId: test.id }) },
    )) as NextResponse;
    expect(trigger.status).toBe(202);
    const created = (await trigger.json()) as { runs: Array<{ id: string }> };
    const runId = created.runs[0].id;

    // Idempotent replay returns the same run.
    const replay = (await postRun(
      request(`https://x/api/v1/tests/${test.id}/runs`, {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": "p15-e2e-1" },
      }),
      { params: Promise.resolve({ testId: test.id }) },
    )) as NextResponse;
    const replayed = (await replay.json()) as { runs: Array<{ id: string }> };
    expect(replayed.runs[0].id).toBe(runId);

    // The worker executes the saved test in a REAL browser.
    const rowBefore = getTestRunById(runId)!;
    expect(rowBefore.saved_test_id).toBe(test.id);
    expect(rowBefore.saved_test_version).toBe(1);
    expect(await worker.tick()).toBe(true);

    const run = getTestRunById(runId)!;
    expect(FINAL).toContain(run.status);
    expect(run.saved_test_id).toBe(test.id);
    expect(run.saved_test_version).toBe(1);

    // Poll the CI endpoint: honest status from the real outcome.
    const poll = (await getRun(request(`https://x/api/v1/tests/${test.id}/runs/${runId}`, { headers: { authorization: `Bearer ${apiKey}` } }), {
      params: Promise.resolve({ testId: test.id, runId }),
    })) as NextResponse;
    expect(poll.status).toBe(200);
    const body = (await poll.json()) as {
      run: { status: string; exitCode: number; results: Array<{ testId: string; status: string; assertions: { total: number } }> };
    };
    expect(["COMPLETED", "FAILED", "TIMEOUT"]).toContain(body.run.status);
    if (body.run.status === "COMPLETED") expect(body.run.exitCode).toBe(0);
    else expect(body.run.exitCode).not.toBe(0);

    // The single result IS the saved test under its deterministic id.
    const parsed = parseResults(run);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].testId).toBe(`saved_${test.id}_v1`);
    expect(parsed.results[0].assertions.length).toBe(1);
    expect(body.run.results[0].testId).toBe(`saved_${test.id}_v1`);

    // Organization isolation on the live system: a foreign key cannot read it.
    const stranger = createUser({ email: "p15-stranger@example.com", passwordHash: "x".repeat(60), name: "S" });
    const strangerOrg = createOrganization({ userId: stranger.id }, { name: "Stranger Co" });
    setOrganizationPlan({ organizationId: strangerOrg.id, planId: "pro", status: "active", seats: 5 });
    const strangerKey = createApiKey({ userId: stranger.id, organizationId: strangerOrg.id }, { name: "s", scopes: ["tests:read"] }).key;
    const cross = (await getRun(request(`https://x/api/v1/tests/${test.id}/runs/${runId}`, { headers: { authorization: `Bearer ${strangerKey}` } }), {
      params: Promise.resolve({ testId: test.id, runId }),
    })) as NextResponse;
    expect(cross.status).toBe(404);
  });
});
