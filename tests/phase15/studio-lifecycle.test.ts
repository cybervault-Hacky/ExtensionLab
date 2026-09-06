import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/observability/errors";
import { createOrganization } from "@/lib/organizations/service";
import { getPackageById } from "@/lib/db/repositories/packages";
import { getSavedTestById, getSavedTestVersion } from "@/lib/db/repositories/saved-tests";
import { storeExtensionPackage } from "@/lib/packages/service";
import {
  createStudioTest,
  describeStudioTest,
  duplicateStudioTest,
  exportStudioTest,
  importStudioTest,
  prepareStudioTestRun,
  requireAccessibleTest,
  updateStudioTest,
  type StudioViewer,
} from "@/lib/testing/studio-service";
import { activatePlan, makeUser, setupPhase15Harness, studioFixtureZip, storedStudioPackage, validDefinition, type Harness } from "./helpers";

/**
 * Phase 15 §16–§22, §34: lifecycle, versioning, tenancy, exact-package
 * binding and import/export.
 */

let harness: Harness;

beforeEach(() => {
  harness = setupPhase15Harness();
});

afterEach(() => {
  harness.teardown();
});

const viewerFor = (user: { id: string }, organizationId: string | null = null): StudioViewer => ({ userId: user.id, organizationId });

async function newUserWithTest(): Promise<{ viewer: StudioViewer; testId: string; packageId: string }> {
  const user = makeUser();
  const { packageId } = await storedStudioPackage(user);
  const created = await createStudioTest(viewerFor(user), { name: "Popup journey", description: "d", tags: ["smoke"], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
  return { viewer: viewerFor(user), testId: created.id, packageId };
}

describe("lifecycle and versioning", () => {
  it("creates a DRAFT pinned to the exact package bytes", async () => {
    const { viewer, testId, packageId } = await newUserWithTest();
    const row = getSavedTestById(testId)!;
    expect(row.status).toBe("DRAFT");
    expect(row.current_version).toBe(1);
    expect(row.package_sha256).toBe(getPackageById(packageId)!.sha256);
    expect(getSavedTestVersion(testId, 1)?.definition_json).toBe(row.definition_json);
  });

  it("bumps an immutable version when the definition changes, and keeps old versions readable", async () => {
    const { viewer, testId } = await newUserWithTest();
    const before = getSavedTestById(testId)!.definition_json;
    const edited = validDefinition();
    (edited.actions as Array<Record<string, unknown>>).push({ type: "reload_page" });
    const updated = await updateStudioTest(viewer, testId, { definition: edited, expectedVersion: 1 });
    expect(updated.current_version).toBe(2);
    expect(getSavedTestVersion(testId, 1)?.definition_json).toBe(before);
    expect(getSavedTestVersion(testId, 2)?.definition_json).not.toBe(before);
  });

  it("rejects concurrent edits via expectedVersion (last writer must reload)", async () => {
    const { viewer, testId } = await newUserWithTest();
    const edited = validDefinition();
    (edited.actions as Array<Record<string, unknown>>).push({ type: "reload_page" });
    await updateStudioTest(viewer, testId, { definition: edited, expectedVersion: 1 });
    const staleEdit = validDefinition();
    (staleEdit.actions as Array<Record<string, unknown>>).push({ type: "wait", milliseconds: 200 });
    await expect(updateStudioTest(viewer, testId, { definition: staleEdit, expectedVersion: 1 })).rejects.toThrow(/changed while you were editing/);
  });

  it("archive makes a test immutable and unrunnable; duplicate gets a new identity with no history", async () => {
    const { viewer, testId } = await newUserWithTest();
    const edited = validDefinition();
    (edited.actions as Array<Record<string, unknown>>).push({ type: "reload_page" });
    await updateStudioTest(viewer, testId, { definition: edited, expectedVersion: 1 }); // v2
    await updateStudioTest(viewer, testId, { status: "ARCHIVED", expectedVersion: 2 });
    await expect(updateStudioTest(viewer, testId, { name: "x" })).rejects.toThrow(/Archived tests are immutable/);
    await expect(prepareStudioTestRun(viewer, testId, { source: "interactive" })).rejects.toThrow(/Archived tests cannot run/);

    const copy = await duplicateStudioTest(viewer, testId);
    expect(copy.id).not.toBe(testId);
    expect(copy.current_version).toBe(1); // fresh identity: no cloned version history
    expect(describeStudioTest(viewer, copy.id).versions).toHaveLength(1);
  });

  it("refuses to run when the stored package bytes changed (SHA-256 binding, no silent substitution)", async () => {
    const user = makeUser();
    const { packageId } = await storedStudioPackage(user);
    const viewer = viewerFor(user);
    const created = await createStudioTest(viewer, { name: "Bound", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
    // Simulate the package being replaced under the test (different content).
    const replacement = await storeExtensionPackage({ userId: user.id, bytes: await studioFixtureZip(JSON.stringify({ manifest_version: 3, name: "Studio Fixture", version: "2.0.1" })), fileName: "studio.zip" });
    // Point the saved test at the new package bytes by direct row update — the
    // situation §16 guards against: definition says package A, packageId now
    // resolves to different bytes.
    const { getDb } = await import("@/lib/db/client");
    getDb().prepare("UPDATE saved_tests SET package_id = ? WHERE id = ?").run(replacement.package.id, created.id);
    await expect(prepareStudioTestRun(viewer, created.id, { source: "interactive" })).rejects.toThrow(/SHA-256 mismatch/);
  });
});

describe("tenancy (§34: no cross-user or cross-org test access)", () => {
  it("personal tests are invisible to other users", async () => {
    const { testId } = await newUserWithTest();
    const stranger = viewerFor(makeUser());
    expect(() => requireAccessibleTest(stranger, testId)).toThrow(AppError);
    await expect(prepareStudioTestRun(stranger, testId, { source: "interactive" })).rejects.toThrow(/not found/i);
  });

  it("org tests are visible to org members but not other orgs or personal viewers", async () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Studio Co" });
    const { packageId } = await storedStudioPackage(owner);
    const orgViewer: StudioViewer = { userId: owner.id, organizationId: org.id };
    const created = await createStudioTest(orgViewer, { name: "Org test", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);

    // Same org, different member (owner is a member by definition here).
    expect(requireAccessibleTest(orgViewer, created.id).id).toBe(created.id);
    // Personal viewer (the same user without the org context) cannot see it.
    expect(() => requireAccessibleTest(viewerFor(owner), created.id)).toThrow(AppError);
    // A different org's member cannot see it.
    const other = makeUser();
    const otherOrg = createOrganization({ userId: other.id }, { name: "Other Co" });
    expect(() => requireAccessibleTest({ userId: other.id, organizationId: otherOrg.id }, created.id)).toThrow(AppError);
  });

  it("rejects cross-browser targets without the entitlement", async () => {
    const user = makeUser(); // free plan
    const { packageId } = await storedStudioPackage(user);
    await expect(
      createStudioTest(viewerFor(user), { name: "Matrix", description: "", tags: [], browserTargets: ["chromium", "firefox"], definition: validDefinition() }, packageId),
    ).rejects.toThrow(/plan/i);
  });

  it("accepts cross-browser targets with the entitlement", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const { packageId } = await storedStudioPackage(user);
    const created = await createStudioTest(viewerFor(user), { name: "Matrix", description: "", tags: [], browserTargets: ["chromium", "firefox"], definition: validDefinition() }, packageId);
    expect(JSON.parse(created.browser_targets_json)).toEqual(["chromium", "firefox"]);
  });
});

describe("import / export (§82)", () => {
  it("exports definition + metadata only — no secrets, no run history", async () => {
    const { viewer, testId } = await newUserWithTest();
    const exported = exportStudioTest(viewer, testId);
    expect(exported.kind).toBe("extensionlab.saved-test");
    expect(exported.schemaVersion).toBe(1);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toMatch(/password|secret|token/i);
    expect(exported.definition.actions.length).toBeGreaterThan(0);
  });

  it("imports a valid export as a fresh DRAFT and rejects tampered files atomically", async () => {
    const user = makeUser();
    const { packageId } = await storedStudioPackage(user);
    const viewer = viewerFor(user);
    const created = await createStudioTest(viewer, { name: "Source", description: "", tags: [], browserTargets: ["chromium"], definition: validDefinition() }, packageId);
    const exported = exportStudioTest(viewer, created.id);

    const imported = await importStudioTest(viewer, JSON.stringify(exported), packageId);
    expect(imported.status).toBe("DRAFT");
    expect(imported.id).not.toBe(created.id);

    // Executable content smuggled into the file is rejected.
    const evil = { ...exported, definition: { ...exported.definition, actions: [{ type: "execute_js", value: "fetch('x')" }] } };
    await expect(importStudioTest(viewer, JSON.stringify(evil), packageId)).rejects.toThrow(/not in the allowlist/i);

    // Unknown top-level fields are rejected.
    const spiky = { ...exported, surprise: true };
    await expect(importStudioTest(viewer, JSON.stringify(spiky), packageId)).rejects.toThrow(/Unexpected field/);

    // Oversized payloads are rejected before parsing anything deep.
    await expect(importStudioTest(viewer, "x".repeat(300 * 1024), packageId)).rejects.toThrow(/limited/i);

    // Not JSON at all.
    await expect(importStudioTest(viewer, "not json", packageId)).rejects.toThrow(/valid JSON/i);
    // Wrong kind marker.
    await expect(importStudioTest(viewer, JSON.stringify({ kind: "other", schemaVersion: 1 }), packageId)).rejects.toThrow(/saved-test export/i);
  });
});
