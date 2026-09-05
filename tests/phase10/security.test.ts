import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { __setTestCookie } from "../__stubs__/next-headers";
import { resetConfigCache } from "@/lib/config/env";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { getActiveWorkspace, WORKSPACE_COOKIE } from "@/lib/organizations/authorization";
import { getPublicReportBySlug, publishReport, unpublishReport } from "@/lib/reports/publications";
import { getSsoConfigView, saveSsoConfig } from "@/lib/sso/service";
import { saveSsoConfig as saveSso } from "@/lib/sso/service";
import { getCoordinationStoreSync } from "@/lib/coordination";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { createReport } from "@/lib/db/repositories/reports";
import { dispatchOrganizationEvent } from "@/lib/webhooks/dispatch";
import { createDomainRow, getDomainById } from "@/lib/organizations/repository";
import { generateDomainVerificationToken } from "@/lib/audit/service";
import { AppError } from "@/lib/observability/errors";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

function orgWithAdmin(name = "Security Co"): { orgId: string; owner: string } {
  const owner = makeUser();
  const org = createOrganization({ userId: owner.id }, { name });
  return { orgId: org.id, owner: owner.id };
}

describe("public report publications", () => {
  it("serves only the safe projection — never org identity or internals", () => {
    const { orgId, owner } = orgWithAdmin();
    const report = createReport({
      userId: owner,
      extensionId: null,
      analysisSnapshotId: null,
      testRunId: null,
      title: "Public Report",
      summary: "A summary",
      healthScore: 88,
      runtimeScore: 91,
      overallScore: 90,
      reportJson: JSON.stringify({
        kind: "cross-browser-matrix",
        browsers: [{ browserId: "chromium", status: "completed", executed: true, engine: "chromium" }],
        compatibility: { score: 95, coverage: 100 },
      }),
      organizationId: orgId,
    });
    const membership = authorizeOrgAction(orgId, owner, "org:publications:manage");
    const publication = publishReport(membership, { reportId: report.id, slug: "acme-public" });
    expect(publication.slug).toBe("acme-public");
    const view = getPublicReportBySlug("acme-public");
    expect(view).not.toBeNull();
    expect(view?.scores.overall).toBe(90);
    expect(view?.browsers[0].browserId).toBe("chromium");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(orgId);
    expect(serialized).not.toContain(owner);
    expect(serialized).not.toContain("storage");
    expect(view?.provenance.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects bad slugs and duplicate slugs; unpublish removes the page", () => {
    const { orgId, owner } = orgWithAdmin("Slugs");
    const report = createReport({ userId: owner, extensionId: null, analysisSnapshotId: null, testRunId: null, title: "T", summary: null, healthScore: 1, runtimeScore: 1, overallScore: 1, reportJson: "{}", organizationId: orgId });
    expect(() => publishReport(authorizeOrgAction(orgId, owner, "org:publications:manage"), { reportId: report.id, slug: "Bad Slug" })).toThrowError(AppError);
    const publication = publishReport(authorizeOrgAction(orgId, owner, "org:publications:manage"), { reportId: report.id, slug: "good-slug" });
    expect(() => publishReport(authorizeOrgAction(orgId, owner, "org:publications:manage"), { reportId: report.id, slug: "good-slug" })).toThrowError(AppError);
    unpublishReport(authorizeOrgAction(orgId, owner, "org:publications:manage"), publication.id);
    expect(getPublicReportBySlug("good-slug")).toBeNull();
  });

  it("reports from other organizations cannot be published under this org", () => {
    const a = orgWithAdmin("Pub A");
    const b = orgWithAdmin("Pub B");
    const reportB = createReport({ userId: b.owner, extensionId: null, analysisSnapshotId: null, testRunId: null, title: "B", summary: null, healthScore: 1, runtimeScore: 1, overallScore: 1, reportJson: "{}", organizationId: b.orgId });
    expect(() => publishReport(authorizeOrgAction(a.orgId, a.owner, "org:publications:manage"), { reportId: reportB.id, slug: "stolen" })).toThrowError(AppError);
  });
});

describe("SSO configuration layer", () => {
  it("masks secrets, never fabricates enforcement without essentials", () => {
    const { orgId, owner } = orgWithAdmin("SSO Co");
    setOrganizationPlan({ organizationId: orgId, planId: "business", status: "active" });
    process.env.SSO_ENABLED = "true";
    resetConfigCache();
    try {
      const saved = saveSso(authorizeOrgAction(orgId, owner, "org:sso:manage"), { protocol: "oidc", status: "enforced", config: { issuer: "https://idp.example.com", clientId: "abc" } });
      // Missing token endpoint/secret → stays configured, not enforced.
      expect(saved.status).toBe("configured");
      expect(saved.config.clientId).toBe("abc");
      const enforced = saveSso(authorizeOrgAction(orgId, owner, "org:sso:manage"), {
        protocol: "oidc",
        status: "enforced",
        config: {
          issuer: "https://idp.example.com",
          authorizationEndpoint: "https://idp.example.com/authorize",
          tokenEndpoint: "https://idp.example.com/token",
          clientId: "abc",
          clientSecret: "super-secret-value",
        },
      });
      expect(enforced.status).toBe("enforced");
      expect(JSON.stringify(enforced.config)).not.toContain("super-secret-value");
      expect(getSsoConfigView(orgId).config.clientSecret).toBe("••••••••");
    } finally {
      delete process.env.SSO_ENABLED;
      resetConfigCache();
    }
  });

  it("SSO requires the entitlement (business plan)", () => {
    const { orgId, owner } = orgWithAdmin("Free SSO");
    expect(() => saveSso(authorizeOrgAction(orgId, owner, "org:sso:manage"), { protocol: "oidc", status: "configured", config: {} })).toThrowError(AppError);
    setOrganizationPlan({ organizationId: orgId, planId: "business", status: "active" });
    process.env.SSO_ENABLED = "true";
    resetConfigCache();
    try {
      expect(saveSso(authorizeOrgAction(orgId, owner, "org:sso:manage"), { protocol: "saml", status: "configured", config: {} }).protocol).toBe("saml");
    } finally {
      delete process.env.SSO_ENABLED;
      resetConfigCache();
    }
  });
});

describe("workspace switching", () => {
  it("cookie values are hints only — memberships decide", async () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Switch Co" });
    // Valid cookie → organization workspace.
    __setTestCookie(WORKSPACE_COOKIE, org.id);
    const active = await getActiveWorkspace(owner.id);
    expect(active.kind).toBe("organization");
    expect(active.organizationId).toBe(org.id);
    // Forged cookie for an org the user does not belong to → personal fallback.
    const outsider = makeUser();
    __setTestCookie(WORKSPACE_COOKIE, org.id);
    const outsiderView = await getActiveWorkspace(outsider.id);
    expect(outsiderView.kind).toBe("personal");
    expect(outsiderView.organizationId).toBeNull();
  });
});

describe("coordination (memory provider)", () => {
  it("fixed-window rate limiting and advisory locks", async () => {
    const store = getCoordinationStoreSync();
    let allowed = 0;
    for (let index = 0; index < 5; index += 1) {
      const verdict = await store.rateLimit("t:bucket", 3, 60_000);
      if (verdict.ok) allowed += 1;
    }
    expect(allowed).toBe(3);
    const lock = await store.withLock("t:lock", 1000, async () => "ran");
    expect(lock).toBe("ran");
  });
});

describe("event dispatch resilience", () => {
  it("dispatch never throws into the business flow", () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Resilient" });
    // Unknown/bogus inputs must not propagate errors.
    expect(() => dispatchOrganizationEvent(org.id, "package.created", { weird: () => undefined })).not.toThrow();
    expect(() => dispatchOrganizationEvent("org_missing", "report.created", {})).not.toThrow();
  });
});

describe("domain verification", () => {
  it("stores hashed-random tokens and never auto-verifies", () => {
    const { orgId } = orgWithAdmin("Domain Co");
    const token = generateDomainVerificationToken();
    expect(token).toMatch(/^extensionlab-verify-/);
    const row = createDomainRow({ organizationId: orgId, domain: "example.com", verificationToken: token });
    const stored = getDomainById(row.id);
    expect(stored?.verified_at ?? null).toBeNull();
    expect(stored?.verification_token).toBe(token);
  });
});
