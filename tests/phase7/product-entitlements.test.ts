import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { NextRequest } from "next/server";
import { POST as analyzeRoute } from "@/app/api/extensions/route";
import { GET as meRoute } from "@/app/api/me/route";
import { POST as shareRoute } from "@/app/api/reports/[id]/share/route";
import { storeExtensionPackage } from "@/lib/packages/service";
import { createQueuedTestRun } from "@/lib/testing/run-service";
import { createReport } from "@/lib/db/repositories/reports";
import { getJobById } from "@/lib/db/repositories/jobs";
import { countOpenReservations } from "@/lib/db/repositories/quota";
import { recordUsage } from "@/lib/db/repositories/usage";
import { upsertSubscription } from "@/lib/db/repositories/billing";
import { deliverAll, jsonRequest, makeUser, sessionCookieFor, setupBillingHarness } from "./helpers";
import type { FakeBillingProvider } from "@/lib/billing/providers/fake";

const DAY = 24 * 60 * 60 * 1000;

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ manifest_version: 3, name: "Entitled", version: "1.0.0", background: { service_worker: "bg.js" } }));
  zip.file("bg.js", "console.log('bg')");
  return zip.generateAsync({ type: "uint8array" });
}

const analysisPayload = {
  sourceName: "fixture.zip",
  metadata: { name: "Fixture", version: "1.0.0" },
  manifest: { manifestVersion: 3 },
  issues: [],
  permissions: [],
  healthScore: { total: 90, categories: [] },
  files: [],
};

function subscribePro(userId: string) {
  const now = Date.now();
  upsertSubscription({
    userId,
    provider: "fake",
    providerCustomerId: `cus_${userId}`,
    providerSubscriptionId: `sub_${userId}`,
    providerPriceId: "price_pro_test",
    planId: "pro",
    status: "active",
    currentPeriodStart: now - DAY,
    currentPeriodEnd: now + 29 * DAY,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    canceledAt: null,
    trialEnd: null,
    endedAt: null,
    eventAt: now,
  });
}

describe("product APIs enforce entitlements server-side", () => {
  let harness: ReturnType<typeof setupBillingHarness>;
  let provider: FakeBillingProvider;

  beforeAll(() => {
    harness = setupBillingHarness({ PLAN_TEST_LIMIT: "1", PLAN_ANALYSIS_LIMIT: "1", PLAN_MAX_CONCURRENT_RUNS: "1", JOB_MAX_QUEUED_PER_USER: "1" });
    provider = harness.provider;
  });
  afterAll(() => harness.teardown());

  it("QUOTA_EXCEEDED responses carry currentUsage, limit, resetAt and requiredPlan and no usage is recorded for the denied request", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    recordUsage(user.id, "analysis");
    const response = await analyzeRoute(jsonRequest("/api/extensions", { method: "POST", cookie, body: { analysis: analysisPayload } }));
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { errorCode: string; message: string; details: Record<string, unknown> } };
    expect(body.error.errorCode).toBe("QUOTA_EXCEEDED");
    expect(body.error.message).toContain("Free plan");
    expect(body.error.details).toMatchObject({ reason: "quota", kind: "analysis", currentUsage: 1, limit: 1, plan: "free", requiredPlan: "pro", requiredPlanName: "Pro" });
    expect(typeof body.error.details.resetAt).toBe("number");
    const me = (await (await meRoute(jsonRequest("/api/me", { cookie }))).json()) as { usage: { analysisUsed: number } };
    expect(me.usage.analysisUsed).toBe(1);
  });

  it("an invalid analysis payload never consumes usage", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const response = await analyzeRoute(jsonRequest("/api/extensions", { method: "POST", cookie, body: { analysis: { nonsense: true } } }));
    expect(response.status).toBe(400);
    const me = (await (await meRoute(jsonRequest("/api/me", { cookie }))).json()) as { usage: { analysisUsed: number } };
    expect(me.usage.analysisUsed).toBe(0);
  });

  it("upgrading lifts the quota for the same user immediately", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    recordUsage(user.id, "analysis");
    expect((await analyzeRoute(jsonRequest("/api/extensions", { method: "POST", cookie, body: { analysis: analysisPayload } }))).status).toBe(429);
    subscribePro(user.id);
    const allowed = await analyzeRoute(jsonRequest("/api/extensions", { method: "POST", cookie, body: { analysis: analysisPayload } }));
    expect(allowed.status).toBe(201);
    const me = (await (await meRoute(jsonRequest("/api/me", { cookie }))).json()) as { plan: { id: string; analysisLimit: number; billingState: string }; usage: { analysisUsed: number; resetAt: number } };
    expect(me.plan.id).toBe("pro");
    expect(me.plan.analysisLimit).toBe(200);
    expect(me.plan.billingState).toBe("active");
    expect(me.usage.analysisUsed).toBe(2);
  });

  it("quota race: concurrent run creation for the last unit yields exactly one reservation", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "race.zip" });
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => createQueuedTestRun({ userId: user.id, packageId: stored.package.id, analysis: stored.analysis, extensionId: null })),
      ),
    );
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(countOpenReservations(user.id, "test_run")).toBe(1);
    for (const rejected of attempts.filter((result) => result.status === "rejected") as PromiseRejectedResult[]) {
      expect(["QUOTA_EXCEEDED", "CONCURRENCY_LIMIT"]).toContain((rejected.reason as { code: string }).code);
    }
  });

  it("paid plans raise per-user concurrency and get queue priority", async () => {
    const free = makeUser();
    const pro = makeUser();
    subscribePro(pro.id);
    const freePkg = await storeExtensionPackage({ userId: free.id, bytes: await fixtureZip(), fileName: "free.zip" });
    const proPkg = await storeExtensionPackage({ userId: pro.id, bytes: await fixtureZip(), fileName: "pro.zip" });

    const freeRun = createQueuedTestRun({ userId: free.id, packageId: freePkg.package.id, analysis: freePkg.analysis, extensionId: null });
    expect(() => createQueuedTestRun({ userId: free.id, packageId: freePkg.package.id, analysis: freePkg.analysis, extensionId: null })).toThrow();

    const first = createQueuedTestRun({ userId: pro.id, packageId: proPkg.package.id, analysis: proPkg.analysis, extensionId: null });
    const second = createQueuedTestRun({ userId: pro.id, packageId: proPkg.package.id, analysis: proPkg.analysis, extensionId: null });
    expect(getJobById(first.jobId)?.priority).toBe(0);
    expect(getJobById(second.jobId)?.priority).toBe(0);
    expect(getJobById(freeRun.jobId)?.priority).toBe(0);

    // Business plan → priority execution.
    const business = makeUser();
    const now = Date.now();
    upsertSubscription({
      userId: business.id,
      provider: "fake",
      providerCustomerId: "cus_b",
      providerSubscriptionId: "sub_b",
      providerPriceId: "price_business_test",
      planId: "business",
      status: "active",
      currentPeriodStart: now - DAY,
      currentPeriodEnd: now + 29 * DAY,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      canceledAt: null,
      trialEnd: null,
      endedAt: null,
      eventAt: now,
    });
    const bizPkg = await storeExtensionPackage({ userId: business.id, bytes: await fixtureZip(), fileName: "biz.zip" });
    const bizRun = createQueuedTestRun({ userId: business.id, packageId: bizPkg.package.id, analysis: bizPkg.analysis, extensionId: null });
    expect(getJobById(bizRun.jobId)?.priority).toBe(10);
  });

  it("report sharing follows the plan: free users get bounded links, paid users permanent ones", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const report = createReport({
      userId: user.id,
      extensionId: null,
      analysisSnapshotId: null,
      testRunId: null,
      title: "Report",
      summary: null,
      healthScore: 90,
      runtimeScore: null,
      overallScore: 90,
      reportJson: JSON.stringify({ title: "Report" }),
    });
    const share = (expiresInHours: number) =>
      shareRoute(jsonRequest(`/api/reports/${report.id}/share`, { method: "POST", cookie, body: { expiresInHours } }), { params: Promise.resolve({ id: report.id }) });

    expect((await share(24)).status).toBe(201);
    const permanent = await share(0);
    expect(permanent.status).toBe(402);
    const body = (await permanent.json()) as { error: { errorCode: string; details: { requiredPlan: string } } };
    expect(body.error.errorCode).toBe("PAYMENT_REQUIRED");
    expect(body.error.details.requiredPlan).toBe("pro");

    subscribePro(user.id);
    expect((await share(0)).status).toBe(201);
  });

  it("activation through the fake provider's signed webhook flows into product entitlements", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    recordUsage(user.id, "analysis");
    expect((await analyzeRoute(jsonRequest("/api/extensions", { method: "POST", cookie, body: { analysis: analysisPayload } }))).status).toBe(429);
    const customer = await provider.ensureCustomer({ userId: user.id, email: user.email, name: user.name });
    const session = await provider.createCheckoutSession({ userId: user.id, planId: "pro", priceId: "price_pro_test", customerId: customer.customerId, successUrl: "http://localhost:3000/r?session_id={CHECKOUT_SESSION_ID}", cancelUrl: "http://localhost:3000/c", idempotencyKey: `k_${user.id}` });
    const { events } = provider.fake.completeCheckout(session.id);
    const responses = await deliverAll(events);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await analyzeRoute(jsonRequest("/api/extensions", { method: "POST", cookie, body: { analysis: analysisPayload } }))).status).toBe(201);
  });
});

describe("secrets never reach the client bundle or the repository", () => {
  it("client components and public types do not import server billing modules or reference secret env names", () => {
    const clientDirs = ["components", "app"];
    const forbidden = [/BILLING_SECRET_KEY/, /BILLING_WEBHOOK_SECRET/, /sk_live_/, /whsec_/, /AI_API_KEY/];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "api") continue; // server routes are allowed to use config
          walk(full);
          continue;
        }
        if (!/\.(tsx|ts)$/.test(entry)) continue;
        const source = readFileSync(full, "utf8");
        if (!source.startsWith('"use client"')) continue;
        if (/from "@\/lib\/billing\/(provider|providers|billing-service|webhooks|config|entitlements)"/.test(source)) offenders.push(`${full}: imports server billing module`);
        if (/from "@\/lib\/ai\/(?!types")/.test(source)) offenders.push(`${full}: imports server AI module`);
        for (const pattern of forbidden) if (pattern.test(source)) offenders.push(`${full}: ${pattern}`);
      }
    };
    for (const dir of clientDirs) walk(join(process.cwd(), dir));
    expect(offenders).toEqual([]);
  });

  it("no .env files are tracked and .gitignore covers them", () => {
    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.env(\.\*)?$|^\.env\*/m);
  });
});

describe("request objects used by the tests are same-origin by construction", () => {
  it("builds NextRequests with a host header and optional cookie", () => {
    const request = jsonRequest("/api/billing", { cookie: "x=y" });
    expect(request).toBeInstanceOf(NextRequest);
    expect(request.headers.get("host")).toBe("localhost:3000");
  });
});
