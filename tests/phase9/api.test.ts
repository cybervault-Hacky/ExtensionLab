import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { GET as listBrowsersRoute } from "@/app/api/browsers/route";
import { GET as capabilitiesRoute } from "@/app/api/browsers/capabilities/route";
import { POST as createMatrixRoute, GET as listMatrixRoute } from "@/app/api/tests/matrix/route";
import { GET as matrixRunRoute } from "@/app/api/tests/matrix/[runId]/route";
import { POST as matrixCancelRoute } from "@/app/api/tests/matrix/[runId]/cancel/route";
import { POST as regressionCompareRoute, GET as regressionGetRoute } from "@/app/api/regressions/compare/route";
import { POST as baselinesRoute } from "@/app/api/baselines/route";
import { createSession } from "@/lib/db/repositories/sessions";
import { generateAuthToken, hashToken } from "@/lib/auth/tokens";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { setBrowserHealthForTests } from "@/lib/browsers/availability";
import { storeExtensionPackage } from "@/lib/packages/service";
import { createExtension, listExtensions } from "@/lib/db/repositories/extensions";
import { createMatrixRun, noteMatrixChildFinished } from "@/lib/testing/matrix-service";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { listExecutionsForMatrix } from "@/lib/db/repositories/browser-matrix";
import { saveTestRunFinal } from "@/lib/db/repositories/test-runs";
import { activatePlan, makeUser, setupHarness, ALL_BROWSERS_HEALTHY, type Harness } from "./helpers";

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
  name: "API Fixture",
  version: "1.0.0",
  action: { default_popup: "popup.html" },
  background: { service_worker: "background.js" },
  permissions: ["storage"],
});

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", MANIFEST);
  zip.file("background.js", "chrome.runtime.onInstalled.addListener(() => {});");
  zip.file("popup.html", "<!doctype html><html><body>Hi</body></html>");
  return zip.generateAsync({ type: "uint8array" });
}

function sessionCookieFor(userId: string): string {
  const token = generateAuthToken();
  createSession({ userId, tokenHash: hashToken(token) });
  return `${SESSION_COOKIE}=${token}`;
}

function jsonRequest(path: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string>; origin?: string } = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: {
      host: "localhost:3000",
      ...(init.origin ? { origin: init.origin } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

function multipartRequest(cookie: string, fields: Record<string, string>, file?: { name: string; bytes: Uint8Array }): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append("file", new File([file.bytes as unknown as BlobPart], file.name, { type: "application/zip" }));
  return new NextRequest("http://localhost:3000/api/tests/matrix", {
    method: "POST",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", cookie },
    body: form,
  });
}

describe("GET /api/browsers (Phase 9)", () => {
  it("requires authentication", async () => {
    const response = await listBrowsersRoute(jsonRequest("/api/browsers"));
    expect(response.status).toBe(401);
  });

  it("lists the three supported browsers with capabilities and no internal details", async () => {
    const user = makeUser();
    const response = await listBrowsersRoute(jsonRequest("/api/browsers", { cookie: sessionCookieFor(user.id) }));
    expect(response.status).toBe(200);
    const { browsers } = (await response.json()) as { browsers: Array<Record<string, unknown>> };
    expect(browsers.map((browser) => browser.browserId).sort()).toEqual(["chromium", "edge", "firefox"]);
    const serialized = JSON.stringify(browsers);
    expect(serialized).not.toMatch(/image|executable|docker|\/var\/|\/usr\/|:9333|container/i);
  });

  it("reflects runtime availability with a safe reason", async () => {
    const user = makeUser();
    setBrowserHealthForTests({ chromium: { browserId: "chromium", available: true }, edge: { browserId: "edge", available: true }, firefox: { browserId: "firefox", available: false, reason: "image_missing" } });
    const response = await listBrowsersRoute(jsonRequest("/api/browsers", { cookie: sessionCookieFor(user.id) }));
    const { browsers } = (await response.json()) as { browsers: Array<{ browserId: string; available: boolean; unavailableReason?: string }> };
    const firefox = browsers.find((browser) => browser.browserId === "firefox")!;
    expect(firefox.available).toBe(false);
    expect(firefox.unavailableReason).toBe("image_missing");
  });

  it("exposes the deterministic capability gates for the test engine", async () => {
    const user = makeUser();
    const response = await capabilitiesRoute(jsonRequest("/api/browsers/capabilities", { cookie: sessionCookieFor(user.id) }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { capabilityGates: { assertions: Record<string, string[]>; actions: Record<string, string[]> } };
    expect(body.capabilityGates.assertions.network_status_equals).toContain("networkStatusCodes");
    expect(body.capabilityGates.actions.open_url).toEqual([]);
  });
});

describe("POST /api/tests/matrix (Phase 9)", () => {
  it("rejects cross-site requests and unauthenticated callers", async () => {
    const user = makeUser();
    const cookie = sessionCookieFor(user.id);
    const crossSite = await createMatrixRoute(jsonRequest("/api/tests/matrix", { method: "POST", cookie, origin: "https://evil.example", body: {} }));
    expect(crossSite.status).toBe(403);
    const anonymous = await createMatrixRoute(jsonRequest("/api/tests/matrix", { method: "POST", body: {} }));
    expect(anonymous.status).toBe(401);
  });

  it("creates a matrix from a stored package for an entitled user", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "api.zip" });
    const response = await createMatrixRoute(
      jsonRequest("/api/tests/matrix", {
        method: "POST",
        cookie: sessionCookieFor(user.id),
        body: { packageId: stored.package.id, browsers: ["chromium", "firefox"], suiteId: "core" },
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { matrixRunId: string; executions: Array<{ browserId: string }>; status: string };
    expect(body.status).toBe("queued");
    expect(body.executions.map((execution) => execution.browserId).sort()).toEqual(["chromium", "firefox"]);
  });

  it("returns 402 for users without the cross-browser entitlement", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "free.zip" });
    const response = await createMatrixRoute(
      jsonRequest("/api/tests/matrix", {
        method: "POST",
        cookie: sessionCookieFor(user.id),
        body: { packageId: stored.package.id, browsers: ["chromium", "firefox"], suiteId: "core" },
      }),
    );
    expect(response.status).toBe(402);
  });

  it("never lets a user launch someone else's package", async () => {
    const owner = makeUser();
    activatePlan(owner.id, "pro");
    const intruder = makeUser();
    activatePlan(intruder.id, "pro");
    const stored = await storeExtensionPackage({ userId: owner.id, bytes: await fixtureZip(), fileName: "owner.zip" });
    const response = await createMatrixRoute(
      jsonRequest("/api/tests/matrix", {
        method: "POST",
        cookie: sessionCookieFor(intruder.id),
        body: { packageId: stored.package.id, browsers: ["chromium"], suiteId: "core" },
      }),
    );
    expect(response.status).toBe(404);
  });

  it("fails closed with 503 when a browser runtime is unavailable", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "unavail.zip" });
    setBrowserHealthForTests({ chromium: { browserId: "chromium", available: true }, edge: { browserId: "edge", available: true }, firefox: { browserId: "firefox", available: false, reason: "image_missing" } });
    const response = await createMatrixRoute(
      jsonRequest("/api/tests/matrix", {
        method: "POST",
        cookie: sessionCookieFor(user.id),
        body: { packageId: stored.package.id, browsers: ["chromium", "firefox"], suiteId: "core" },
      }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { errorCode: string; message: string } };
    expect(body.error.errorCode).toBe("BROWSER_RUNTIME_UNAVAILABLE");
    expect(body.error.message).not.toMatch(/docker|\/var\/|\/usr\/|:9333|localhost/i);
  });

  it("accepts a multipart upload and stores the package before scheduling", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const bytes = await fixtureZip();
    const response = await createMatrixRoute(multipartRequest(sessionCookieFor(user.id), { browsers: "chromium,edge", suiteId: "core" }, { name: "upload.zip", bytes }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { matrixRunId: string };
    expect(body.matrixRunId).toBeTruthy();
  });

  it("rejects a multipart upload without a file", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const response = await createMatrixRoute(multipartRequest(sessionCookieFor(user.id), { browsers: "chromium", suiteId: "core" }));
    expect(response.status).toBe(400);
  });

  it("lists matrix runs for the owner only", async () => {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "list.zip" });
    const analysis = await analyzeZipBytes(await fixtureZip(), "list.zip");
    const created = await createMatrixRun({ userId: user.id, packageId: stored.package.id, extensionId: stored.package.extensionId, analysis, browsers: ["chromium", "firefox"], suiteId: "core", testUrl: undefined });
    const mine = await listMatrixRoute(jsonRequest("/api/tests/matrix", { cookie: sessionCookieFor(user.id) }));
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { items: Array<{ id: string }> };
    expect(body.items.some((item) => item.id === created.matrixRunId)).toBe(true);
    const other = makeUser();
    const theirs = await listMatrixRoute(jsonRequest("/api/tests/matrix", { cookie: sessionCookieFor(other.id) }));
    const theirsBody = (await theirs.json()) as { items: Array<{ id: string }> };
    expect(theirsBody.items.some((item) => item.id === created.matrixRunId)).toBe(false);
  });
});

describe("matrix run detail and cancellation (Phase 9)", () => {
  async function preparedMatrix() {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const bytes = await fixtureZip();
    const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "detail.zip" });
    const analysis = await analyzeZipBytes(bytes, "detail.zip");
    const created = await createMatrixRun({ userId: user.id, packageId: stored.package.id, extensionId: stored.package.extensionId, analysis, browsers: ["chromium", "firefox"], suiteId: "core", testUrl: undefined });
    return { user, created };
  }

  function callContext(runId: string) {
    return { params: Promise.resolve({ runId }) };
  }

  it("shows the owner a full view with executions and never leaks hosts", async () => {
    const { user, created } = await preparedMatrix();
    const response = await matrixRunRoute(jsonRequest(`/api/tests/matrix/${created.matrixRunId}`, { cookie: sessionCookieFor(user.id) }), callContext(created.matrixRunId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { matrixRun: Record<string, unknown>; executions: Array<Record<string, unknown>> };
    expect(body.matrixRun.id).toBe(created.matrixRunId);
    expect(body.executions).toHaveLength(2);
    expect(JSON.stringify(body)).not.toMatch(/sandbox_fake|localhost:9|docker|container/i);
  });

  it("hides other users' matrix runs", async () => {
    const { created } = await preparedMatrix();
    const intruder = makeUser();
    const response = await matrixRunRoute(jsonRequest(`/api/tests/matrix/${created.matrixRunId}`, { cookie: sessionCookieFor(intruder.id) }), callContext(created.matrixRunId));
    expect(response.status).toBe(404);
  });

  it("cancels for the owner and is a no-op for others", async () => {
    const { user, created } = await preparedMatrix();
    const intruder = makeUser();
    const denied = await matrixCancelRoute(jsonRequest(`/api/tests/matrix/${created.matrixRunId}/cancel`, { method: "POST", cookie: sessionCookieFor(intruder.id) }), callContext(created.matrixRunId));
    expect(denied.status).toBe(404);
    const allowed = await matrixCancelRoute(jsonRequest(`/api/tests/matrix/${created.matrixRunId}/cancel`, { method: "POST", cookie: sessionCookieFor(user.id) }), callContext(created.matrixRunId));
    expect([200, 202]).toContain(allowed.status);
    const body = (await allowed.json()) as { matrixRun: { status: string } };
    expect(["cancelled", "partial", "queued", "running"]).toContain(body.matrixRun.status);
  });
});

describe("baselines and regression comparison (Phase 9)", () => {
  async function finishedMatrix(version: string) {
    const user = makeUser();
    activatePlan(user.id, "pro");
    const extension = createExtension({ userId: user.id, name: "API Fixture", version, manifestVersion: "v3", sourceName: `${version}.zip`, healthScore: 90 });
    const zip = new JSZip();
    zip.file("manifest.json", MANIFEST.replace("1.0.0", version));
    zip.file("background.js", "chrome.runtime.onInstalled.addListener(() => {});");
    zip.file("popup.html", "<!doctype html><html><body>Hi</body></html>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: `${version}.zip`, extensionId: extension.id });
    const analysis = await analyzeZipBytes(bytes, `${version}.zip`);
    const created = await createMatrixRun({ userId: user.id, packageId: stored.package.id, extensionId: stored.package.extensionId, analysis, browsers: ["chromium"], suiteId: "core", testUrl: undefined });
    for (const execution of listExecutionsForMatrix(created.matrixRunId)) {
      saveTestRunFinal({
        id: execution.test_run_id,
        status: "completed",
        score: version === "1.0.0" ? 100 : 40,
        total: 1,
        passed: version === "1.0.0" ? 1 : 0,
        failed: version === "1.0.0" ? 0 : 1,
        warnings: 0,
        skipped: 0,
        timeout: 0,
        errorCount: version === "1.0.0" ? 0 : 1,
        completedAt: Date.now(),
        resultJson: JSON.stringify({ results: [{ testId: "core", name: "core", status: version === "1.0.0" ? "passed" : "failed", steps: [], assertions: [], errors: version === "1.0.0" ? [] : ["Popup did not open."], warnings: [], evidence: [], duration: 1, startedAt: 0, finishedAt: 1, category: "page", description: "" }] }),
        diagnosticsJson: null,
        eventsJson: null,
        outcome: version === "1.0.0" ? "PASSED" : "FAILED",
      });
      noteMatrixChildFinished(execution.test_run_id);
    }
    return { user, created };
  }

  function storedExtensionId(userId: string): string | null {
    const extensions = listExtensions(userId, { page: 1, limit: 10 });
    return extensions.items.length > 0 ? extensions.items[0].id : null;
  }

  it("gates baselines behind the regression entitlement", async () => {
    const free = makeUser();
    const response = await baselinesRoute(jsonRequest("/api/baselines", { method: "POST", cookie: sessionCookieFor(free.id), body: { matrixRunId: "mx_123" } }));
    expect(response.status).toBe(402);
  });

  it("designates a baseline, then compares a current matrix with PASS→FAIL regressions", async () => {
    const { user, created } = await finishedMatrix("1.0.0");
    const cookie = sessionCookieFor(user.id);
    const designate = await baselinesRoute(jsonRequest("/api/baselines", { method: "POST", cookie, body: { matrixRunId: created.matrixRunId } }));
    expect(designate.status).toBe(201);

    // Second matrix on the same extension with a failing version.
    const zip = new JSZip();
    zip.file("manifest.json", MANIFEST.replace("1.0.0", "1.1.0"));
    zip.file("background.js", "chrome.runtime.onInstalled.addListener(() => {});");
    zip.file("popup.html", "<!doctype html><html><body>Hi</body></html>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const extensionId = (JSON.parse(MANIFEST.replace("1.0.0", "1.0.0")) && storedExtensionId(user.id)) ?? null;
    const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: "1.1.0.zip", extensionId });
    const analysis = await analyzeZipBytes(bytes, "1.1.0.zip");
    const current = await createMatrixRun({ userId: user.id, packageId: stored.package.id, extensionId: stored.package.extensionId, analysis, browsers: ["chromium"], suiteId: "core", testUrl: undefined });
    for (const execution of listExecutionsForMatrix(current.matrixRunId)) {
      saveTestRunFinal({
        id: execution.test_run_id,
        status: "completed",
        score: 40,
        total: 1,
        passed: 0,
        failed: 1,
        warnings: 0,
        skipped: 0,
        timeout: 0,
        errorCount: 1,
        completedAt: Date.now(),
        resultJson: JSON.stringify({ results: [{ testId: "core", name: "core", status: "failed", steps: [], assertions: [], errors: ["Popup did not open."], warnings: [], evidence: [], duration: 1, startedAt: 0, finishedAt: 1, category: "page", description: "" }] }),
        diagnosticsJson: null,
        eventsJson: null,
        outcome: "FAILED",
      });
      noteMatrixChildFinished(execution.test_run_id);
    }

    // Auto-resolves the designated baseline when previous is omitted.
    const compare = await regressionCompareRoute(
      jsonRequest("/api/regressions/compare", { method: "POST", cookie, body: { currentMatrixRunId: current.matrixRunId } }),
    );
    expect(compare.status).toBe(201);
    const body = (await compare.json()) as {
      comparisonId: string;
      result: {
        browsers: Array<{
          browserId: string;
          executed: { previous: boolean; current: boolean };
          regressions: Array<{ testId: string; from: string; to: string; kind: string }>;
          improvements: Array<{ testId: string; from: string; to: string }>;
        }>;
        aggregate: { regressionCount: number; improvementCount: number; insufficientData: boolean };
      };
    };
    const chromium = body.result.browsers.find((browser) => browser.browserId === "chromium")!;
    expect(chromium.regressions.some((entry) => entry.from === "passed" && entry.to === "failed")).toBe(true);
    expect(body.result.aggregate.regressionCount).toBeGreaterThan(0);

    // Stored result is retrievable by id, for the owner only.
    const fetched = await regressionGetRoute(jsonRequest(`/api/regressions/compare?id=${body.comparisonId}`, { cookie }));
    expect(fetched.status).toBe(200);
    const intruder = makeUser();
    const denied = await regressionGetRoute(jsonRequest(`/api/regressions/compare?id=${body.comparisonId}`, { cookie: sessionCookieFor(intruder.id) }));
    expect(denied.status).toBe(404);
  });

  it("rejects comparison when no baseline is designated and none is provided", async () => {
    const { user, created } = await finishedMatrix("1.0.0");
    const response = await regressionCompareRoute(
      jsonRequest("/api/regressions/compare", { method: "POST", cookie: sessionCookieFor(user.id), body: { currentMatrixRunId: created.matrixRunId } }),
    );
    expect(response.status).toBe(409);
  });

  it("lists comparisons for the owner", async () => {
    const user = makeUser();
    const response = await regressionGetRoute(jsonRequest("/api/regressions/compare", { cookie: sessionCookieFor(user.id) }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });
});
