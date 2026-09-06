import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { POST as postRun, GET as listRuns } from "@/app/api/v1/tests/[testId]/runs/route";
import { GET as getRun } from "@/app/api/v1/tests/[testId]/runs/[runId]/route";
import { createApiKey, authenticateApiKey, DEFAULT_SCOPES, API_SCOPES } from "@/lib/api-keys/service";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { createStudioTest, updateStudioTest, type StudioViewer } from "@/lib/testing/studio-service";
import { ciRunExitCode, ciRunStatus } from "@/lib/api/v1-tests-support";
import type { TestRunRow } from "@/lib/db/schema/types";
import { activatePlan, makeUser, setupPhase15Harness, storedStudioPackage, validDefinition, type Harness } from "./helpers";

/**
 * Phase 15 CI surface (§52–§57, §86): API-key auth via the EXISTING v1 stack
 * (no second auth), safe-parameter validation, idempotent triggers, org
 * isolation, honest status/exit codes. No browser execution is faked: runs
 * stay queued and report their true state.
 */

let harness: Harness;

beforeEach(() => {
  harness = setupPhase15Harness();
});

afterEach(() => {
  harness.teardown();
});

function request(url: string, key: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(url, { method: init.method ?? "GET", body: init.body, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
}

interface Ctx {
  key: string;
  orgId: string;
  userId: string;
  testId: string;
  viewer: StudioViewer;
}

async function ciContext(): Promise<Ctx> {
  const owner = makeUser();
  activatePlan(owner.id, "pro");
  const org = createOrganization({ userId: owner.id }, { name: `CI Co ${Math.random().toString(16).slice(2, 6)}` });
  setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
  const key = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "ci", scopes: ["tests:read", "tests:write"] }).key;
  const { packageId } = await storedStudioPackage(owner);
  const viewer: StudioViewer = { userId: owner.id, organizationId: org.id };
  const test = await createStudioTest(viewer, { name: "CI test", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
  return { key, orgId: org.id, userId: owner.id, testId: test.id, viewer };
}

describe("POST /api/v1/tests/:testId/runs", () => {
  it("rejects keys without the tests:write scope", async () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "NoScope" });
    setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
    const readKey = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "ro", scopes: ["tests:read"] }).key;
    const context = await ciContext();
    const response = (await postRun(request(`https://x/api/v1/tests/${context.testId}/runs`, readKey, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), {
      params: Promise.resolve({ testId: context.testId }),
    })) as NextResponse;
    expect(response.status).toBe(403);
  });

  it("rejects invalid keys outright", async () => {
    const context = await ciContext();
    const response = (await postRun(request(`https://x/api/v1/tests/${context.testId}/runs`, "elk_invalid", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), {
      params: Promise.resolve({ testId: context.testId }),
    })) as NextResponse;
    expect(response.status).toBe(401);
    expect(() => authenticateApiKey(request(`https://x/api/v1/tests/t/runs`, "elk_invalid"))).toThrow();
  });

  it("never exposes another org's test (wrong org = 404)", async () => {
    const context = await ciContext();
    const outsiderOwner = makeUser();
    activatePlan(outsiderOwner.id, "pro");
    const outsiderOrg = createOrganization({ userId: outsiderOwner.id }, { name: "Outsider" });
    setOrganizationPlan({ organizationId: outsiderOrg.id, planId: "pro", status: "active", seats: 5 });
    const outsiderKey = createApiKey({ userId: outsiderOwner.id, organizationId: outsiderOrg.id }, { name: "o", scopes: ["tests:write"] }).key;
    const response = (await postRun(request(`https://x/api/v1/tests/${context.testId}/runs`, outsiderKey, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), {
      params: Promise.resolve({ testId: context.testId }),
    })) as NextResponse;
    expect(response.status).toBe(404);
  });

  it("queues an ACTIVE test, validates parameters, and honors Idempotency-Key", async () => {
    const context = await ciContext();
    await updateStudioTest(context.viewer, context.testId, { status: "ACTIVE" });

    // DRAFT is rejected for CI before activation… (covered separately below)
    const body = JSON.stringify({ browser: "chromium" });
    const first = (await postRun(
      request(`https://x/api/v1/tests/${context.testId}/runs`, context.key, { method: "POST", body, headers: { "content-type": "application/json", "idempotency-key": "build-42" } }),
      { params: Promise.resolve({ testId: context.testId }) },
    )) as NextResponse;
    expect(first.status).toBe(202);
    const created = (await first.json()) as { runs: Array<{ id: string }> };
    expect(created.runs).toHaveLength(1);
    expect(getTestRunById(created.runs[0].id)!.status).toBe("queued");

    // Replay with the same Idempotency-Key returns the same run — no duplicate.
    const replay = (await postRun(
      request(`https://x/api/v1/tests/${context.testId}/runs`, context.key, { method: "POST", body, headers: { "content-type": "application/json", "idempotency-key": "build-42" } }),
      { params: Promise.resolve({ testId: context.testId }) },
    )) as NextResponse;
    const replayed = (await replay.json()) as { runs: Array<{ id: string }> };
    expect(replayed.runs[0].id).toBe(created.runs[0].id);

    // Unknown parameters are rejected (no passthrough).
    const spiky = (await postRun(
      request(`https://x/api/v1/tests/${context.testId}/runs`, context.key, { method: "POST", body: JSON.stringify({ shell: "rm -rf" }), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ testId: context.testId }) },
    )) as NextResponse;
    expect(spiky.status).toBe(400);

    // Bad variable type rejected.
    const badVar = (await postRun(
      request(`https://x/api/v1/tests/${context.testId}/runs`, context.key, { method: "POST", body: JSON.stringify({ variables: { x: { evil: 1 } } }), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ testId: context.testId }) },
    )) as NextResponse;
    expect(badVar.status).toBe(400);
  });

  it("refuses to run DRAFT tests from CI", async () => {
    const context = await ciContext(); // still DRAFT
    const response = (await postRun(request(`https://x/api/v1/tests/${context.testId}/runs`, context.key, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), {
      params: Promise.resolve({ testId: context.testId }),
    })) as NextResponse;
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").toMatch(/ACTIVE/);
  });
});

describe("polling + status mapping (§53, §86)", () => {
  it("maps internal states onto the CI enum with honest exit codes", async () => {
    const context = await ciContext();
    await updateStudioTest(context.viewer, context.testId, { status: "ACTIVE" });
    const trigger = (await postRun(request(`https://x/api/v1/tests/${context.testId}/runs`, context.key, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), {
      params: Promise.resolve({ testId: context.testId }),
    })) as NextResponse;
    const created = (await trigger.json()) as { runs: Array<{ id: string }> };
    const runId = created.runs[0].id;

    // Poll the queued run.
    const poll = (await getRun(request(`https://x/api/v1/tests/${context.testId}/runs/${runId}`, context.key), {
      params: Promise.resolve({ testId: context.testId, runId }),
    })) as NextResponse;
    expect(poll.status).toBe(200);
    const body = (await poll.json()) as { run: { status: string; exitCode: number; testVersion: number } };
    expect(["QUEUED", "STARTING", "RUNNING"]).toContain(body.run.status);
    expect(body.run.exitCode).toBe(1);
    expect(body.run.testVersion).toBe(1);

    // Another org's key cannot read the run.
    const outsiderOwner = makeUser();
    const outsiderOrg = createOrganization({ userId: outsiderOwner.id }, { name: "PollOutsider" });
    setOrganizationPlan({ organizationId: outsiderOrg.id, planId: "pro", status: "active", seats: 5 });
    const outsiderKey = createApiKey({ userId: outsiderOwner.id, organizationId: outsiderOrg.id }, { name: "o", scopes: ["tests:read"] }).key;
    const cross = (await getRun(request(`https://x/api/v1/tests/${context.testId}/runs/${runId}`, outsiderKey), {
      params: Promise.resolve({ testId: context.testId, runId }),
    })) as NextResponse;
    expect(cross.status).toBe(404);
  });

  it("COMPLETED is the only 0; CANCELLED is 130; infrastructure errors never succeed", () => {
    expect(ciRunExitCode("COMPLETED")).toBe(0);
    expect(ciRunExitCode("FAILED")).toBe(1);
    expect(ciRunExitCode("TIMEOUT")).toBe(1);
    expect(ciRunExitCode("CANCELLED")).toBe(130);
    expect(ciRunStatus(fakeRun({ status: "completed", outcome: "INFRASTRUCTURE_ERROR" })).status).toBe("FAILED");
    expect(ciRunStatus(fakeRun({ status: "completed", outcome: "PASSED" })).status).toBe("COMPLETED");
    expect(ciRunStatus(fakeRun({ status: "running" })).status).toBe("RUNNING");
    expect(ciRunStatus(fakeRun({ status: "queued" })).status).toBe("QUEUED");
  });

  it("lists runs for the test with pagination", async () => {
    const context = await ciContext();
    await updateStudioTest(context.viewer, context.testId, { status: "ACTIVE" });
    await postRun(request(`https://x/api/v1/tests/${context.testId}/runs`, context.key, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), {
      params: Promise.resolve({ testId: context.testId }),
    });
    const list = (await listRuns(request(`https://x/api/v1/tests/${context.testId}/runs?limit=10`, context.key), {
      params: Promise.resolve({ testId: context.testId }),
    })) as NextResponse;
    expect(list.status).toBe(200);
    const body = (await list.json()) as { runs: Array<{ testId: string }>; pagination: { total: number } };
    expect(body.pagination.total).toBe(1);
    expect(body.runs[0].testId).toBe(context.testId);
  });
});

describe("scopes reuse the existing catalog (no new auth)", () => {
  it("tests:read and tests:write already exist in API_SCOPES and defaults stay read-only", () => {
    expect(API_SCOPES).toContain("tests:read");
    expect(API_SCOPES).toContain("tests:write");
    expect(DEFAULT_SCOPES).toContain("tests:read");
    expect(DEFAULT_SCOPES).not.toContain("tests:write");
  });
});

function fakeRun(overrides: Partial<TestRunRow>): TestRunRow {
  return {
    id: "run_x",
    user_id: "u",
    extension_id: null,
    status: "completed",
    score: 100,
    total: 1,
    passed: 1,
    failed: 0,
    warnings: 0,
    skipped: 0,
    timeout: 0,
    error_count: 0,
    started_at: null,
    completed_at: null,
    result_json: null,
    diagnostics_json: null,
    events_json: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as TestRunRow;
}
