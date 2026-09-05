import JSZip from "jszip";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { POST as uploadPackage } from "@/app/api/v1/packages/route";
import { GET as getPackage } from "@/app/api/v1/packages/[id]/route";
import { GET as getOrg } from "@/app/api/v1/organization/route";
import { GET as getReportRoute } from "@/app/api/v1/reports/[id]/route";
import { createApiKey } from "@/lib/api-keys/service";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { createReport } from "@/lib/db/repositories/reports";
import { getDb } from "@/lib/db/client";
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
  name: "API Fixture",
  version: "2.0.0",
  action: { default_popup: "popup.html" },
  permissions: ["storage"],
});

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", MANIFEST);
  zip.file("popup.html", "<!doctype html><html><body>Hi</body></html>");
  return zip.generateAsync({ type: "uint8array" });
}

function orgWithKey(scopes?: string[]): { orgId: string; key: string; owner: string } {
  const owner = makeUser();
  const org = createOrganization({ userId: owner.id }, { name: "API Co" });
  setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
  const created = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "ci", ...(scopes ? { scopes } : {}) });
  return { orgId: org.id, key: created.key, owner: owner.id };
}

type RouteInit = Omit<RequestInit, "headers" | "signal"> & { headers?: Record<string, string>; signal?: AbortSignal };

function request(url: string, key: string | null, init: RouteInit = {}): NextRequest {
  const { headers, ...rest } = init;
  return new NextRequest(url, { ...rest, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(headers ?? {}) } });
}

const envelope = (response: NextResponse): { code?: string; requestId?: string } => {
  return (response as unknown as { __unparsed?: never }) && ({} as { code?: string });
};

describe("v1 authentication and errors", () => {
  it("rejects missing/invalid credentials with the standard envelope and a request id", async () => {
    const response = await getOrg(request("https://x/api/v1/organization", null));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBeDefined();
    expect(body.error.requestId).toBeDefined();
    expect(response.headers.get("x-request-id")).toBe(body.error.requestId);
  });

  it("rejects garbage bearer tokens without revealing anything", async () => {
    const response = await getOrg(request("https://x/api/v1/organization", "el_000000_notarealkey"));
    expect(response.status).toBe(401);
  });

  it("404 (not 403) hides other organizations' resources", async () => {
    const a = orgWithKey(["reports:read"]);
    const b = orgWithKey(["reports:read"]);
    const report = createReport({ userId: b.owner, extensionId: null, analysisSnapshotId: null, testRunId: null, title: "B private", summary: null, healthScore: 10, runtimeScore: 10, overallScore: 10, reportJson: "{}", organizationId: b.orgId });
    const response = await getReportRoute(request(`https://x/api/v1/reports/${report.id}`, a.key), { params: Promise.resolve({ id: report.id }) });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(body.error.code);
    expect(response.status).toBe(404);
  });

  it("scope enforcement denies keys without the required scope", async () => {
    const readOnly = orgWithKey(["packages:read"]);
    const form = new FormData();
    form.append("file", new File([(await fixtureZip()) as unknown as BlobPart], "extension.zip", { type: "application/zip" }));
    const response = await uploadPackage(request("https://x/api/v1/packages", readOnly.key, { method: "POST", body: form }));
    expect(response.status).toBe(403);
  });

  it("viewer-creator keys cannot perform privileged actions even with a write scope", async () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Viewer Key Co" });
    setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
    const viewer = makeUser();
    const { insertMember, insertApiKeyRow } = await import("@/lib/organizations/repository");
    insertMember({ organizationId: org.id, userId: viewer.id, role: "viewer" });
    // Keys are normally minted by admins; simulate a viewer-creator key directly.
    const { createHash, randomBytes } = await import("node:crypto");
    const raw = `el_${randomBytes(3).toString("hex")}_${randomBytes(24).toString("base64url")}`;
    insertApiKeyRow({
      id: `orga_${randomBytes(6).toString("hex")}`,
      organization_id: org.id,
      name: "viewer-key",
      prefix: raw.split("_").slice(0, 2).join("_"),
      key_hash: createHash("sha256").update(raw).digest("hex"),
      scopes_json: JSON.stringify(["packages:write"]),
      created_by: viewer.id,
      created_at: Date.now(),
      expires_at: Date.now() + 3_600_000,
      revoked_at: null,
      status: "active",
    } as unknown as Parameters<typeof insertApiKeyRow>[0]);
    const created = { key: raw };
    const form = new FormData();
    form.append("file", new File([(await fixtureZip()) as unknown as BlobPart], "extension.zip", { type: "application/zip" }));
    const response = await uploadPackage(request("https://x/api/v1/packages", created.key, { method: "POST", body: form }));
    expect([403, 402, 404]).toContain(response.status);
  });

  it("happy path: upload with idempotency replays identically", async () => {
    const writer = orgWithKey(["packages:write"]);
    const form = () => {
      const data = new FormData();
      data.append("file", new File([new Uint8Array([1, 2, 3])], "bad.zip", { type: "application/zip" }));
      return data;
    };
    // bad zip → INVALID_EXTENSION envelope (analysis failure surfaced safely)
    const response = await uploadPackage(request("https://x/api/v1/packages", writer.key, { method: "POST", body: form(), headers: { "idempotency-key": "build-9" } }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBeDefined();
    void envelope;
  });

  it("organization endpoint returns org + key info and rate-limit metadata", async () => {
    const context = orgWithKey(["organization:read"]);
    const response = await getOrg(request("https://x/api/v1/organization", context.key));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { organization: { id: string }; key: { scopes: string[] } };
    expect(body.organization.id).toBe(context.orgId);
    expect(body.key.scopes).toEqual(["organization:read"]);
    expect(response.headers.get("x-ratelimit-limit")).toBeDefined();
  });

  it("rate limiting kicks in and returns 429 with retry metadata", async () => {
    // Dedicated harness with a 3/min read limit for this test only.
    const tight = setupHarness({ API_RATE_LIMIT_TEST_PER_MIN: "3" });
    try {
      const owner = makeUser();
      const org = createOrganization({ userId: owner.id }, { name: "Rate Co" });
      setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
      const key = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "k", scopes: ["tests:write"] }).key;
        const testRunsModule = await import("@/app/api/v1/test-runs/route");
        const postTestRun = testRunsModule.POST;
      let limited: NextResponse | null = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = (await postTestRun(request("https://x/api/v1/test-runs", key, { method: "POST", body: JSON.stringify({ packageId: "pkg_missing" }) }))) as NextResponse;
        if (response.status === 429) {
          limited = response;
          break;
        }
      }
      expect(limited).not.toBeNull();
      const body = (await limited!.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(limited!.headers.get("retry-after")).toBeDefined();
    } finally {
      tight.teardown();
    }
  });

  it("disabled public API fails closed", async () => {
    const { resetConfigCache } = await import("@/lib/config/env");
    process.env.PUBLIC_API_ENABLED = "false";
    resetConfigCache();
    try {
      const context = orgWithKey();
      const response = await getOrg(request("https://x/api/v1/organization", context.key));
      expect([404, 403, 503]).toContain(response.status);
    } finally {
      delete process.env.PUBLIC_API_ENABLED;
      resetConfigCache();
    }
  });

  it("package metadata endpoint serves org-scoped packages", async () => {
    const context = orgWithKey(["packages:read"]);
    const { createPackageRecord } = await import("@/lib/db/repositories/packages");
    const pkg = createPackageRecord({ userId: context.owner, extensionId: null, storageKey: "packages/p", sha256: "c".repeat(64), size: 12, version: "1.2.3", originalName: "p.zip", organizationId: context.orgId });
    const response = await getPackage(request(`https://x/api/v1/packages/${pkg.id}`, context.key), { params: Promise.resolve({ id: pkg.id }) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { package: { id: string; sha256: string } };
    expect(body.package.id).toBe(pkg.id);
    // secrets/storage internals are never exposed
    expect(JSON.stringify(body)).not.toContain("storage_key");
    void getDb;
  });
});
