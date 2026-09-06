import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as createRoute, GET as listRoute } from "@/app/api/browser-sessions/route";
import { GET as sessionRoute } from "@/app/api/browser-sessions/[id]/route";
import { POST as inputRoute } from "@/app/api/browser-sessions/[id]/input/route";
import { POST as stopRoute } from "@/app/api/browser-sessions/[id]/stop/route";
import { GET as screenshotRoute } from "@/app/api/browser-sessions/[id]/screenshot/route";
import { GET as adminRoute } from "@/app/api/admin/browser-sessions/route";
import { deleteOwnedPackage, storeExtensionPackage } from "@/lib/packages/service";
import { stopInteractiveSession } from "@/lib/interactive/service";
import { createSessionArtifactRecord, getSessionById } from "@/lib/db/repositories/browser-sessions";
import { sessionCookieFor } from "../phase7/helpers";
import { FakeDriver, makeUser, setupHarness, startReadySession, type Harness } from "./helpers";

/**
 * HTTP surface authorization and the security regression net: the auth chain
 * runs user → session ownership → entitlement on every route, cross-tenant
 * callers see plain 404s, and no response ever leaks runtime internals.
 */

let harness: Harness;
let driver: FakeDriver;

beforeEach(() => {
  harness = setupHarness();
  driver = new FakeDriver();
});
afterEach(() => harness.teardown());

function request(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: {
      host: "localhost:3000",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const FORBIDDEN_SUBSTRINGS = [
  "runnerToken",
  "runner_token",
  "controlPort",
  "control_port",
  "containerId",
  "container_id",
  "tempDir",
  "temp_dir",
  "sandboxId",
  "sandbox_id",
  "storageKey",
  "storage_key",
  "runtimeJson",
];

function expectNoRuntimeInternals(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    expect(serialized.includes(needle)).toBe(false);
  }
}

describe("browser-session API authorization", () => {
  it("rejects anonymous callers with 401", async () => {
    const anonymous = await createRoute(request("/api/browser-sessions", { method: "POST", body: { packageId: "pkg_x" } }));
    expect(anonymous.status).toBe(401);
    const anonymousGet = await sessionRoute(request("/api/browser-sessions/ibs_x"), ctx("ibs_x"));
    expect(anonymousGet.status).toBe(401);
    const anonymousList = await listRoute(request("/api/browser-sessions"));
    expect(anonymousList.status).toBe(401);
  });

  it("enforces same-origin on mutating routes like every other route", async () => {
    const user = makeUser();
    const crossOrigin = await createRoute(
      request("/api/browser-sessions", {
        method: "POST",
        cookie: sessionCookieFor(user.id),
        body: { packageId: "pkg_x" },
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("hides other users' sessions behind 404 on every subroute", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const stranger = makeUser();
    const strangerCookie = sessionCookieFor(stranger.id);

    const strangerView = await sessionRoute(request(`/api/browser-sessions/${sessionId}`, { cookie: strangerCookie }), ctx(sessionId));
    expect(strangerView.status).toBe(404);
    expect(
      (
        await inputRoute(
          request(`/api/browser-sessions/${sessionId}/input`, {
            method: "POST",
            cookie: strangerCookie,
            body: { action: { type: "click", x: 1, y: 1 } },
          }),
          ctx(sessionId),
        )
      ).status,
    ).toBe(404);
    expect(
      (await stopRoute(request(`/api/browser-sessions/${sessionId}/stop`, { method: "POST", cookie: strangerCookie }), ctx(sessionId))).status,
    ).toBe(404);
    expect((await screenshotRoute(request(`/api/browser-sessions/${sessionId}/screenshot`, { cookie: strangerCookie }), ctx(sessionId))).status).toBe(404);

    // The owner still sees their session, and the view is runtime-free.
    const ownerCookie = sessionCookieFor(user.id);
    const owned = await sessionRoute(request(`/api/browser-sessions/${sessionId}`, { cookie: ownerCookie }), ctx(sessionId));
    expect(owned.status).toBe(200);
    const body = (await owned.json()) as { session: unknown };
    expectNoRuntimeInternals(body.session);

    const list = await listRoute(request("/api/browser-sessions", { cookie: strangerCookie }));
    const listBody = (await list.json()) as { sessions: Array<{ id: string }> };
    expect(listBody.sessions.map((session) => session.id)).not.toContain(sessionId);
  });

  it("creates sessions only for packages the caller owns", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const row = getSessionById(sessionId)!;
    const stranger = makeUser();

    // Cross-tenant package binding is a 404, never an error hint.
    const stolen = await createRoute(
      request("/api/browser-sessions", {
        method: "POST",
        cookie: sessionCookieFor(stranger.id),
        body: { packageId: row.package_id! },
      }),
    );
    expect(stolen.status).toBe(404);

    // A well-formed request for a missing package is also 404.
    const missing = await createRoute(
      request("/api/browser-sessions", { method: "POST", cookie: sessionCookieFor(user.id), body: { packageId: "pkg_missing" } }),
    );
    expect(missing.status).toBe(404);

    // Malformed ids never reach the database layer.
    const malformed = await createRoute(
      request("/api/browser-sessions", {
        method: "POST",
        cookie: sessionCookieFor(user.id),
        body: { packageId: "../../etc/passwd" },
      }),
    );
    expect([400, 404]).toContain(malformed.status);
  });

  it("never starts a session for a deleted package — no substitution", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await (await import("./helpers")).fixtureZip(), fileName: "ext.zip" });
    const cookie = sessionCookieFor(user.id);
    const created = await createRoute(
      request("/api/browser-sessions", { method: "POST", cookie, body: { packageId: stored.package.id } }),
    );
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string; packageSha256: string } };
    expect(session.packageSha256).toHaveLength(64);

    await deleteOwnedPackage(user.id, stored.package.id);
    const startRoute = (await import("@/app/api/browser-sessions/[id]/start/route")).POST;
    const restarted = await startRoute(
      request(`/api/browser-sessions/${session.id}/start`, { method: "POST", cookie }),
      ctx(session.id),
    );
    // 201 with a job that will fail closed, or an explicit error — but never READY.
    const startBody = (await restarted.json().catch(() => ({}))) as { session?: { status?: string } };
    expect(startBody.session?.status ?? "QUEUED").not.toBe("READY");
  });

  it("validates input route payloads", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const cookie = sessionCookieFor(user.id);
    const noAction = await inputRoute(
      request(`/api/browser-sessions/${sessionId}/input`, { method: "POST", cookie, body: {} }),
      ctx(sessionId),
    );
    expect(noAction.status).toBe(400);

    const oversized = await inputRoute(
      request(`/api/browser-sessions/${sessionId}/input`, {
        method: "POST",
        cookie,
        body: { action: { type: "type_text", text: "a".repeat(64 * 1024) } },
      }),
      ctx(sessionId),
    );
    expect(oversized.status).toBe(400);

    const cdp = await inputRoute(
      request(`/api/browser-sessions/${sessionId}/input`, {
        method: "POST",
        cookie,
        body: { action: { type: "cdp", method: "Runtime.evaluate", params: "1" } },
      }),
      ctx(sessionId),
    );
    expect([400, 422]).toContain(cdp.status);
  });
});

describe("screenshot transport envelope", () => {
  it("serves PNG frames with private no-store + sandbox headers", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const response = await screenshotRoute(
      request(`/api/browser-sessions/${sessionId}/screenshot`, { cookie: sessionCookieFor(user.id) }),
      ctx(sessionId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0x89);
  });
});

describe("admin surface", () => {
  it("is fail-closed when the admin API is disabled", async () => {
    await startReadySession(driver);
    const response = await adminRoute(request("/api/admin/browser-sessions"));
    expect(response.status).toBe(404);
  });

  it("lists sessions for operators without runtime internals", async () => {
    harness.teardown();
    harness = setupHarness({ ADMIN_API_ENABLED: "true", ADMIN_API_TOKEN: "test-admin-token" });
    driver = new FakeDriver();
    const { sessionId } = await startReadySession(driver);
    await stopInteractiveSession((getSessionById(sessionId)!.user_id), sessionId, driver);

    const unauthorized = await adminRoute(request("/api/admin/browser-sessions", { headers: { authorization: "Bearer wrong" } }));
    expect(unauthorized.status).toBe(401);

    const authorized = await adminRoute(
      request("/api/admin/browser-sessions", { headers: { authorization: "Bearer test-admin-token" } }),
    );
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as { sessions: Array<Record<string, unknown>> };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
    expectNoRuntimeInternals(body.sessions);
    const finished = body.sessions.find((session) => session.id === sessionId);
    expect(finished).toBeDefined();
    expect(finished!.stopReason).toBeTypeOf("string");
  });
});

describe("security regression net", () => {
  it("artifact records never expose storage keys through views", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const { listSessionArtifactViews } = await import("@/lib/interactive/service");
    createSessionArtifactRecord({
      sessionId,
      userId: user.id,
      storageKey: "screenshots/secret-key.png",
      size: 10,
      sha256: "a".repeat(64),
      contentType: "image/png",
      label: null,
      packageVersion: "1.2.0",
      packageSha256: "b".repeat(64),
      browser: "chromium",
      browserVersion: "140.0.0.0",
      expiresAt: Date.now() + 60_000,
    });
    const views = listSessionArtifactViews(user.id, sessionId);
    expect(views.length).toBeGreaterThan(0);
    expectNoRuntimeInternals(views);
  });
});
