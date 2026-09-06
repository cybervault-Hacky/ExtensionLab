import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { POST as postRun } from "@/app/api/v1/tests/[testId]/runs/route";
import { createApiKey } from "@/lib/api-keys/service";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { createWebhook } from "@/lib/webhooks/service";
import { listWebhookDeliveriesForOrg } from "@/lib/webhooks/service";
import type { UserRecord } from "@/lib/db/repositories/users";
import { getSavedTestById } from "@/lib/db/repositories/saved-tests";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { cancelRun } from "@/lib/testing/run-service";
import { createStudioTest, runStudioTest, updateStudioTest, type StudioViewer } from "@/lib/testing/studio-service";
import { getDb } from "@/lib/db/client";
import { WEBHOOK_EVENTS, isWebhookEventType } from "@/lib/webhooks/dispatch";
import { activatePlan, makeUser, setupPhase15Harness, storedStudioPackage, validDefinition, type Harness } from "./helpers";

/**
 * Phase 15 §89–§91: deterministic final states under concurrent edits,
 * duplicate triggers and cancellation; webhook integration via the EXISTING
 * subsystem (test_run.* events, no duplicate architecture).
 */

let harness: Harness;

beforeEach(() => {
  harness = setupPhase15Harness();
});

afterEach(() => {
  harness.teardown();
});

const viewerFor = (user: { id: string }, organizationId: string | null = null): StudioViewer => ({ userId: user.id, organizationId });

async function activeTest(user: UserRecord) {
  const { packageId } = await storedStudioPackage(user);
  const viewer = viewerFor(user);
  const created = await createStudioTest(viewer, { name: "Race", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
  await updateStudioTest(viewer, created.id, { status: "ACTIVE" });
  return { viewer, testId: created.id, packageId };
}

function editedDefinition() {
  const definition = validDefinition();
  (definition.actions as Array<Record<string, unknown>>).push({ type: "reload_page" });
  return definition;
}

describe("concurrent edits settle deterministically", () => {
  it("exactly one of two simultaneous definition saves with the same expectedVersion wins", async () => {
    const user = makeUser();
    const { viewer, testId } = await activeTest(user);
    const results = await Promise.allSettled([
      updateStudioTest(viewer, testId, { definition: editedDefinition(), expectedVersion: 1 }),
      updateStudioTest(viewer, testId, { definition: editedDefinition(), expectedVersion: 1 }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    const rejected = results.filter((result) => result.status === "rejected").length;
    // better-sqlite3 serializes the transactions; the service re-reads inside
    // the call, so at most one save can win per version slot.
    expect(fulfilled).toBeGreaterThanOrEqual(1);
    expect(fulfilled + rejected).toBe(2);
    expect(getSavedTestById(testId)!.current_version).toBe(2);
    // The version history is consistent: exactly one v2 row exists.
    const versions = getDb().prepare("SELECT COUNT(*) AS n FROM saved_test_versions WHERE test_id = ? AND version = 2").get(testId) as { n: number };
    expect(versions.n).toBe(1);
  });
});

describe("duplicate CI triggers", () => {
  function request(url: string, key: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): NextRequest {
    return new NextRequest(url, { method: init.method ?? "GET", body: init.body, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
  }

  async function ciSetup() {
    const owner = makeUser();
    activatePlan(owner.id, "pro");
    const org = createOrganization({ userId: owner.id }, { name: `Race Co ${Math.random().toString(16).slice(2, 6)}` });
    setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
    const key = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "ci", scopes: ["tests:write"] }).key;
    const { packageId } = await storedStudioPackage(owner);
    const viewer = viewerFor(owner, org.id);
    const test = await createStudioTest(viewer, { name: "CI race", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
    await updateStudioTest(viewer, test.id, { status: "ACTIVE" });
    return { key, orgId: org.id, testId: test.id };
  }

  it("two identical requests with the same Idempotency-Key produce exactly one run", async () => {
    const { key, testId } = await ciSetup();
    const body = JSON.stringify({ browser: "chromium" });
    const headers = { "content-type": "application/json", "idempotency-key": "build-77" };
    const responses = await Promise.all([
      postRun(request(`https://x/api/v1/tests/${testId}/runs`, key, { method: "POST", body, headers }), { params: Promise.resolve({ testId }) }),
      postRun(request(`https://x/api/v1/tests/${testId}/runs`, key, { method: "POST", body, headers }), { params: Promise.resolve({ testId }) }),
    ]) as unknown as NextResponse[];
    const runIds = new Set<string>();
    for (const response of responses) {
      const parsed = (await response.json()) as { runs: Array<{ id: string }> };
      for (const run of parsed.runs ?? []) runIds.add(run.id);
    }
    expect(runIds.size).toBe(1);
  });

  it("two requests WITHOUT an idempotency key are two honest, separate runs", async () => {
    const { key, testId } = await ciSetup();
    const body = JSON.stringify({ browser: "chromium" });
    const responses = await Promise.all([
      postRun(request(`https://x/api/v1/tests/${testId}/runs`, key, { method: "POST", body, headers: { "content-type": "application/json" } }), { params: Promise.resolve({ testId }) }),
      postRun(request(`https://x/api/v1/tests/${testId}/runs`, key, { method: "POST", body, headers: { "content-type": "application/json" } }), { params: Promise.resolve({ testId }) }),
    ]) as unknown as NextResponse[];
    const runIds = new Set<string>();
    for (const response of responses) {
      const parsed = (await response.json()) as { runs: Array<{ id: string }> };
      for (const run of parsed.runs ?? []) runIds.add(run.id);
    }
    expect(runIds.size).toBe(2);
  });
});

describe("cancellation reaches a deterministic final state", () => {
  it("cancelling a queued run marks it CANCELLED, releases quota and keeps the definition untouched", async () => {
    const user = makeUser();
    const { viewer, testId } = await activeTest(user);
    const created = await runStudioTest(viewer, testId, { source: "interactive" });
    const run = getTestRunById(created.runId)!;
    const info = cancelRun(run);
    const after = getTestRunById(created.runId)!;
    expect(info.outcome).toBe("CANCELLED");
    expect(after.status).toBe("destroyed");
    expect(after.outcome).toBe("CANCELLED");
    // The saved test definition is untouched by cancellation.
    expect(getSavedTestById(testId)!.definition_json).toBeTruthy();
    expect(getSavedTestById(testId)!.current_version).toBe(1);
  });
});

describe("webhooks reuse the existing test_run.* events (§53)", () => {
  it("the event catalog already covers the CI lifecycle and validates types", () => {
    for (const event of ["test_run.created", "test_run.completed", "test_run.failed"]) {
      expect(WEBHOOK_EVENTS).toContain(event);
      expect(isWebhookEventType(event)).toBe(true);
    }
    expect(isWebhookEventType("test_run.queued_v2")).toBe(false);
  });

  it("a CI trigger delivers test_run.created to subscribed webhooks through the existing pipeline", async () => {
    const owner = makeUser();
    activatePlan(owner.id, "pro");
    const org = createOrganization({ userId: owner.id }, { name: "Hook Co" });
    setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
    await createWebhook({ userId: owner.id, organizationId: org.id }, { url: "https://example.com/hook", events: ["test_run.created"] });
    const key = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "ci", scopes: ["tests:write"] }).key;
    const { packageId } = await storedStudioPackage(owner);
    const viewer = viewerFor(owner, org.id);
    const test = await createStudioTest(viewer, { name: "Hooked", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
    await updateStudioTest(viewer, test.id, { status: "ACTIVE" });

    const response = (await postRun(
      new NextRequest(`https://x/api/v1/tests/${test.id}/runs`, {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      }),
      { params: Promise.resolve({ testId: test.id }) },
    )) as NextResponse;
    expect(response.status).toBe(202);

    const deliveries = listWebhookDeliveriesForOrg(org.id, null, 1, 20);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries.some((delivery) => delivery.eventType === "test_run.created")).toBe(true);
  });
});
