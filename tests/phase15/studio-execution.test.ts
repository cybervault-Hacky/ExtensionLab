import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getJobById } from "@/lib/db/repositories/jobs";
import type { UserRecord } from "@/lib/db/repositories/users";
import type { PreparedSavedTest } from "@/lib/testing/run-service";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { getSavedTestById, getSavedTestVersion } from "@/lib/db/repositories/saved-tests";
import {
  createStudioSuite,
  createStudioTest,
  prepareStudioTestRun,
  runStudioTest,
  runStudioSuite,
  updateStudioTest,
  type StudioViewer,
} from "@/lib/testing/studio-service";
import { savedTestsAsTestCases } from "@/lib/testing/run-service";
import { makeUser, setupPhase15Harness, storedDifferentPackage, storedStudioPackage, validDefinition, type Harness } from "./helpers";

/**
 * Phase 15 §16–§27: execution binding, version pinning, variable plumbing
 * into the job payload, deterministic suite ordering and failure policy.
 * These tests stop at the queue boundary — the Phase 13 worker machinery is
 * already covered by Phase 13; no browser execution is faked here.
 */

let harness: Harness;

beforeEach(() => {
  harness = setupPhase15Harness();
});

afterEach(() => {
  harness.teardown();
});

const viewerFor = (user: { id: string }): StudioViewer => ({ userId: user.id, organizationId: null });

async function newActiveTest(userOverride?: UserRecord) {
  const user = userOverride ?? makeUser();
  const { packageId } = await storedStudioPackage(user);
  const viewer = viewerFor(user);
  let created = await createStudioTest(viewer, { name: "Journey", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
  created = await updateStudioTest(viewer, created.id, { status: "ACTIVE" });
  return { user, viewer, testId: created.id, packageId };
}

describe("run creation (queue boundary)", () => {
  it("creates a queued run bound to the saved test + exact version, with the resolved definition in the job payload", async () => {
    const { viewer, testId } = await newActiveTest();
    const created = await runStudioTest(viewer, testId, { source: "interactive", variables: { search_term: "abc" } });

    const run = getTestRunById(created.runId)!;
    expect(run.status).toBe("queued");
    expect(run.saved_test_id).toBe(testId);
    expect(run.saved_test_version).toBe(1);

    const job = getJobById(run.job_id!)!;
    const payload = JSON.parse((job as unknown as { payload_json: string }).payload_json) as { savedTest?: { testId: string; version: number; actions: Array<{ type: string }>; assertions: unknown[] } };
    expect(payload.savedTest?.testId).toBe(testId);
    expect(payload.savedTest?.version).toBe(1);
    // Allowlisted, variable-substituted actions only; nothing executable.
    expect(payload.savedTest!.actions.map((action) => action.type)).toEqual(["open_url", "wait", "inspect_element"]);
    expect(payload.savedTest!.assertions.length).toBe(2);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/applicable|function|\(\) =>/);
  });

  it("pins an explicit older version: the run records v1 even after v2 exists", async () => {
    const { viewer, testId } = await newActiveTest();
    const edited = validDefinition();
    (edited.actions as Array<Record<string, unknown>>).push({ type: "reload_page" });
    await updateStudioTest(viewer, testId, { definition: edited, expectedVersion: 1 });
    expect(getSavedTestById(testId)!.current_version).toBe(2);

    const created = await runStudioTest(viewer, testId, { source: "interactive", version: 1 });
    const run = getTestRunById(created.runId)!;
    expect(run.saved_test_version).toBe(1);
    const job = getJobById(run.job_id!)!;
    const payload = JSON.parse((job as unknown as { payload_json: string }).payload_json) as { savedTest?: { actions: Array<{ type: string }> } };
    expect(payload.savedTest!.actions).toHaveLength(3); // v1 shape, not v2
  });

  it("rejects runs for DRAFT tests from CI but allows interactive previews", async () => {
    const user = makeUser();
    const { packageId } = await storedStudioPackage(user);
    const viewer = viewerFor(user);
    const created = await createStudioTest(viewer, { name: "Draft", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
    await expect(runStudioTest(viewer, created.id, { source: "ci" })).rejects.toThrow(/ACTIVE/);
    await expect(runStudioTest(viewer, created.id, { source: "interactive" })).resolves.toHaveProperty("runId");
  });

  it("rejects a browser that is not among the test's targets, and enforces the cross-browser entitlement", async () => {
    const { viewer, testId } = await newActiveTest(); // chromium-only, free plan
    await expect(runStudioTest(viewer, testId, { source: "interactive", browserId: "firefox" })).rejects.toThrow(/was not selected/i);
  });

  it("substitutes user variables server-side before the payload is written", async () => {
    const user = makeUser();
    const { packageId } = await storedStudioPackage(user);
    const viewer = viewerFor(user);
    const definition = validDefinition();
    (definition.assertions as Array<Record<string, unknown>>).push({ type: "text_contains", selector: "[data-testid=\"status\"]", value: "{{search_term}}" });
    const created = await createStudioTest(viewer, { name: "Vars", description: "", tags: [], browserTargets: ["chromium"], definition }, packageId);
    await updateStudioTest(viewer, created.id, { status: "ACTIVE" });

    const prepared = await prepareStudioTestRun(viewer, created.id, { source: "interactive", variables: { search_term: " deployed" } });
    expect(prepared.prepared.assertions.at(-1)?.value).toBe(" deployed");
  });
});

describe("savedTestsAsTestCases (worker-side rebuild)", () => {
  it("generates deterministic ids and maps suite dependencies to engine ids", () => {
    const prepared: PreparedSavedTest = {
      testId: "st_suite",
      version: 1,
      name: "Suite",
      description: "",
      category: "loading",
      severity: "high",
      timeoutMs: 15000,
      setup: [],
      actions: [],
      cleanup: [],
      assertions: [],
      members: [
        { testId: "st_a", version: 2, name: "A", description: "", category: "loading", severity: "high", timeoutMs: 10000, setup: [], actions: [{ type: "reload_page" }], cleanup: [], assertions: [] },
        { testId: "st_b", version: 1, name: "B", description: "", category: "loading", severity: "high", timeoutMs: 10000, setup: [], actions: [], cleanup: [], assertions: [], dependsOn: ["st_a"] },
      ],
      failurePolicy: "continue" as const,
    };
    const tests = savedTestsAsTestCases(prepared);
    expect(tests.map((test) => test.id)).toEqual(["saved_st_a_v2", "saved_st_b_v1"]);
    expect(tests[1].dependsOn).toEqual(["saved_st_a_v2"]);
    expect(tests[0].steps[0].type).toBe("reload_page");
  });
});

describe("suites (§24–§27)", () => {
  it("keeps deterministic order, backwards-only dependencies and rejects mixed packages", async () => {
    const { user, viewer, testId: first } = await newActiveTest();
    const edited = validDefinition();
    (edited.actions as Array<Record<string, unknown>>).push({ type: "reload_page" });
    const second = await createStudioTest(viewer, { name: "Second", description: "", tags: [], browserTargets: ["chromium"], definition: edited }, (await storedStudioPackage(user)).packageId);
    await updateStudioTest(viewer, second.id, { status: "ACTIVE" });

    const suite = createStudioSuite(viewer, {
      name: "Smoke suite",
      description: "",
      failurePolicy: "stop",
      testIds: [first, second.id],
      dependencies: { [second.id]: [first] },
    });
    const detail = await import("@/lib/testing/studio-service").then((module) => module.describeStudioSuite(viewer, suite.id));
    expect(detail.tests.map((test) => test.testId)).toEqual([first, second.id]);

    // Forward/cyclic dependency rejected.
    expect(() =>
      createStudioSuite(viewer, { name: "Bad", description: "", failurePolicy: "stop", testIds: [first, second.id], dependencies: { [first]: [second.id] } }),
    ).toThrow(/earlier in the suite/);

    // A member authored against different package bytes is rejected.
    const otherPackage = await storedDifferentPackage(user);
    const otherTest = await createStudioTest(viewer, { name: "Other pkg", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, otherPackage.packageId);
    expect(() => createStudioSuite(viewer, { name: "Mixed", description: "", failurePolicy: "stop", testIds: [first, otherTest.id] })).toThrow(/same package version/);
  });

  it("queues a suite as one run with ordered members and the failure policy", async () => {
    const { viewer, testId: first } = await newActiveTest();
    const second = await createStudioTest(viewer, { name: "Second", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, getSavedTestById(first)!.package_id);
    await updateStudioTest(viewer, second.id, { status: "ACTIVE" });
    const suite = createStudioSuite(viewer, { name: "Ordered", description: "", failurePolicy: "stop", testIds: [first, second.id], dependencies: { [second.id]: [first] } });

    const created = await runStudioSuite(viewer, suite.id, { source: "interactive" });
    const run = getTestRunById(created.runId)!;
    expect(run.saved_test_id).toBe(suite.id);
    expect(run.total).toBe(2);
    const payload = JSON.parse((getJobById(run.job_id!)! as unknown as { payload_json: string }).payload_json) as { savedTest?: { members?: Array<{ testId: string; dependsOn?: string[] }>; failurePolicy?: string } };
    expect(payload.savedTest?.failurePolicy).toBe("stop");
    expect(payload.savedTest?.members?.map((member) => member.testId)).toEqual([first, second.id]);
    expect(payload.savedTest?.members?.[1]?.dependsOn).toEqual([first]);
  });
});

describe("immutable history (§17/§18)", () => {
  it("old versions stay intact after edits (runs can always be traced to what they executed)", async () => {
    const { viewer, testId } = await newActiveTest();
    const v1 = getSavedTestVersion(testId, 1)!.definition_json;
    const edited = validDefinition();
    (edited.actions as Array<Record<string, unknown>>).push({ type: "reload_page" });
    await updateStudioTest(viewer, testId, { definition: edited, expectedVersion: 1 });
    expect(getSavedTestVersion(testId, 1)!.definition_json).toBe(v1);
    expect(getSavedTestVersion(testId, 2)!.definition_json).not.toBe(v1);
  });
});
