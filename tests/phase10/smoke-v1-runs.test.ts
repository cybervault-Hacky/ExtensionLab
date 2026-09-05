import JSZip from "jszip";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { POST as postTestRuns } from "@/app/api/v1/test-runs/route";
import { GET as getMatrix } from "@/app/api/v1/browser-matrices/[id]/route";
import { createApiKey } from "@/lib/api-keys/service";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { storeExtensionPackage } from "@/lib/packages/service";
import { activatePlan, makeUser, setupHarness, ALL_BROWSERS_HEALTHY, type Harness } from "./helpers";
import { setBrowserHealthForTests } from "@/lib/browsers/availability";

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
  version: "1.4.0",
  action: { default_popup: "popup.html" },
  background: { service_worker: "background.js" },
});

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", MANIFEST);
  zip.file("background.js", "chrome.runtime.onInstalled.addListener(() => {});");
  zip.file("popup.html", "<!doctype html><html><body>Hi</body></html>");
  return zip.generateAsync({ type: "uint8array" });
}

function request(url: string, key: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(url, { method: init.method ?? "GET", body: init.body, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
}

describe("v1 test-runs happy path", () => {
  it("creates a matrix for multiple browsers with idempotent replay", async () => {
    const owner = makeUser();
    // Run/test quotas are drawn from the key creator's personal plan; the
    // organization plan gates features (API access, matrices). Both are pro here.
    activatePlan(owner.id, "pro");
    const org = createOrganization({ userId: owner.id }, { name: "Matrix API Co" });
    setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
    const key = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "ci", scopes: ["tests:write", "browser-matrix:read"] }).key;
    const stored = await storeExtensionPackage({ userId: owner.id, organizationId: org.id, bytes: await fixtureZip(), fileName: "m.zip" });

    const body = JSON.stringify({ packageId: stored.package.id, browsers: ["chromium", "edge"] });
    const first = (await postTestRuns(request("https://x/api/v1/test-runs", key, { method: "POST", body, headers: { "content-type": "application/json", "idempotency-key": "run-1" } }))) as NextResponse;
    expect(first.status).toBe(202);
    const created = (await first.json()) as { browserMatrix: { id: string; executions: Array<{ browserId: string }> } };
    expect(created.browserMatrix.executions).toHaveLength(2);

    // Idempotent replay: same key + body → same matrix, no duplicate.
    const replay = (await postTestRuns(request("https://x/api/v1/test-runs", key, { method: "POST", body, headers: { "content-type": "application/json", "idempotency-key": "run-1" } }))) as NextResponse;
    const replayed = (await replay.json()) as { browserMatrix: { id: string } };
    expect(replayed.browserMatrix.id).toBe(created.browserMatrix.id);

    // Org-scoped read works for the same org's key.
    const view = (await getMatrix(request(`https://x/api/v1/browser-matrices/${created.browserMatrix.id}`, key), {
      params: Promise.resolve({ id: created.browserMatrix.id }),
    })) as NextResponse;
    expect(view.status).toBe(200);
    const matrix = (await view.json()) as { browserMatrix: { matrixRun: { id: string } } };
    expect(matrix.browserMatrix.matrixRun.id).toBe(created.browserMatrix.id);

    // A package from another org is a 404.
    const outsiderOwner = makeUser();
    activatePlan(outsiderOwner.id, "pro");
    const outsiderOrg = createOrganization({ userId: outsiderOwner.id }, { name: "Outsider" });
    setOrganizationPlan({ organizationId: outsiderOrg.id, planId: "pro", status: "active", seats: 5 });
    const outsiderKey = createApiKey({ userId: outsiderOwner.id, organizationId: outsiderOrg.id }, { name: "o", scopes: ["tests:write"] }).key;
    const cross = (await postTestRuns(request("https://x/api/v1/test-runs", outsiderKey, { method: "POST", body: JSON.stringify({ packageId: stored.package.id, browsers: ["chromium"] }), headers: { "content-type": "application/json" } }))) as NextResponse;
    expect(cross.status).toBe(404);
  });
});
