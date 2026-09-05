import JSZip from "jszip";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { storeExtensionPackage } from "@/lib/packages/service";
import { getOrgPackage } from "@/lib/db/repositories/packages";
import { getOrgReport } from "@/lib/db/repositories/reports";
import { getOrgTestRun } from "@/lib/db/repositories/test-runs";
import { getOrgMatrixRun } from "@/lib/db/repositories/browser-matrix";
import { createReport } from "@/lib/db/repositories/reports";
import { createTestRun } from "@/lib/db/repositories/test-runs";
import { createMatrixRunRow } from "@/lib/db/repositories/browser-matrix";
import { createPackageRecord } from "@/lib/db/repositories/packages";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "Iso Fixture",
  version: "1.0.0",
  action: { default_popup: "popup.html" },
});

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", MANIFEST);
  return zip.generateAsync({ type: "uint8array" });
}

describe("cross-tenant isolation", () => {
  it("packages, runs, matrices and reports are invisible across organizations", async () => {
    const ownerA = makeUser();
    const ownerB = makeUser();
    const orgA = createOrganization({ userId: ownerA.id }, { name: "Tenant A" });
    const orgB = createOrganization({ userId: ownerB.id }, { name: "Tenant B" });
    for (const org of [orgA, orgB]) setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });

    const stored = await storeExtensionPackage({ userId: ownerA.id, organizationId: orgA.id, bytes: await fixtureZip(), fileName: "a.zip" });
    // Same organization sees it; the other never does.
    expect(getOrgPackage(orgA.id, stored.package.id)?.id).toBe(stored.package.id);
    expect(getOrgPackage(orgB.id, stored.package.id)).toBeNull();

    const pkgB = createPackageRecord({ userId: ownerB.id, extensionId: null, storageKey: "packages/b", sha256: "b".repeat(64), size: 1, version: null, originalName: "b.zip", organizationId: orgB.id });
    expect(getOrgPackage(orgA.id, pkgB.id)).toBeNull();

    const runA = createTestRun({ userId: ownerA.id, extensionId: null, status: "completed", organizationId: orgA.id });
    expect(getOrgTestRun(orgB.id, runA.id)).toBeNull();
    expect(getOrgTestRun(orgA.id, runA.id)?.id).toBe(runA.id);

    const matrixA = createMatrixRunRow({ userId: ownerA.id, extensionId: null, packageId: stored.package.id, testSuiteId: "core", testSuiteName: "Core", browsers: ["chromium"], organizationId: orgA.id });
    expect(getOrgMatrixRun(orgB.id, matrixA.id)).toBeNull();
    expect(getOrgMatrixRun(orgA.id, matrixA.id)?.id).toBe(matrixA.id);
    expect(getOrgMatrixRun(orgA.id, matrixA.id)?.organization_id).toBe(orgA.id);

    const reportA = createReport({ userId: ownerA.id, extensionId: null, analysisSnapshotId: null, testRunId: runA.id, title: "A report", summary: null, healthScore: 90, runtimeScore: 80, overallScore: 85, reportJson: "{}", organizationId: orgA.id });
    expect(getOrgReport(orgB.id, reportA.id)).toBeNull();
    expect(getOrgReport(orgA.id, reportA.id)?.id).toBe(reportA.id);
  });

  it("org-owned rows keep their organization stamp end to end", async () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Stamped" });
    const stored = await storeExtensionPackage({ userId: owner.id, organizationId: org.id, bytes: await fixtureZip(), fileName: "s.zip" });
    const row = getOrgPackage(org.id, stored.package.id);
    expect(row?.organization_id).toBe(org.id);
  });
});
