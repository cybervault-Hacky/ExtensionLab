import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as createRoute } from "@/app/api/browser-sessions/route";
import { POST as keepaliveRoute } from "@/app/api/browser-sessions/[id]/keepalive/route";
import { createInteractiveBrowserStartHandler } from "@/lib/jobs/handlers/interactive-browser";
import { runInteractiveSweep } from "@/lib/interactive/sweep";
import {
  createInteractiveSession,
  parseRuntimeInfo,
  reloadExtension,
  startInteractiveSession,
  stopInteractiveSession,
} from "@/lib/interactive/service";
import { getSessionById, listSessionEvents } from "@/lib/db/repositories/browser-sessions";
import { getJobById } from "@/lib/db/repositories/jobs";
import { deleteOwnedPackage, storeExtensionPackage } from "@/lib/packages/service";
import { countUsageThisMonth } from "@/lib/db/repositories/usage";
import { AppError } from "@/lib/observability/errors";
import type { UserRecord } from "@/lib/db/repositories/users";
import { existsSync } from "node:fs";
import { sessionCookieFor } from "../phase7/helpers";
import {
  FakeDriver,
  enqueueStart,
  fakeContext,
  fixtureZip,
  makeUser,
  setupHarness,
  startReadySession,
  type Harness,
} from "./helpers";

/**
 * Capacity, quotas, and every termination path: entitlements are reused from
 * Phase 7 (plan gate, per-period units, concurrency slots) and every failure
 * or timeout path removes the container and the extracted package.
 */

let harness: Harness;
let driver: FakeDriver;

beforeEach(() => {
  harness = setupHarness();
  driver = new FakeDriver();
});
afterEach(() => harness.teardown());

function createRequest(userId: string, packageId: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/browser-sessions", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", cookie: sessionCookieFor(userId) },
    body: JSON.stringify({ packageId }),
  });
}

async function enqueueAndHandleStart(sessionId: string, userId: string, startDriver: FakeDriver = driver) {
  const handler = createInteractiveBrowserStartHandler({ driver: startDriver, sandboxProbe: async () => ({ available: true }) });
  return handler.handle(fakeContext<"INTERACTIVE_BROWSER_START">(getJobById(enqueueStart(sessionId, userId).id)!, { sessionId }));
}

async function createdSession(user: UserRecord): Promise<{ sessionId: string; packageId: string }> {
  const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
  const row = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
  return { sessionId: row.id, packageId: stored.package.id };
}

describe("plan entitlements and per-period quotas", () => {
  it("denies the feature with a 402 paywall envelope when the plan lacks it", async () => {
    harness.teardown();
    harness = setupHarness({ PLAN_FREE_INTERACTIVE_BROWSER_ENABLED: "false" });
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const response = await createRoute(createRequest(user.id, stored.package.id));
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { errorCode: string; message: string } };
    expect(body.error.errorCode).toBe("PAYMENT_REQUIRED");
    expect(body.error.message.toLowerCase()).toContain("plan");
  });

  it("counts started sessions against the plan quota and returns 429 when exhausted", async () => {
    harness.teardown();
    harness = setupHarness({ PLAN_FREE_INTERACTIVE_SESSIONS: "1" });
    driver = new FakeDriver();
    const user = makeUser();
    const first = await startReadySession(driver, user);
    expect(countUsageThisMonth(user.id, "interactive_browser")).toBe(1);

    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext2.zip" });
    const response = await createRoute(createRequest(user.id, stored.package.id));
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { errorCode: string } };
    expect(body.error.errorCode).toBe("QUOTA_EXCEEDED");
    expect(first.sessionId).toBeTruthy();
  });

  it("releases the reservation when a session is stopped before it starts", async () => {
    harness.teardown();
    harness = setupHarness({ PLAN_FREE_INTERACTIVE_SESSIONS: "1" });
    driver = new FakeDriver();
    const user = makeUser();
    const { sessionId } = await createdSession(user); // reserved, not consumed
    await stopInteractiveSession(user.id, sessionId, driver);
    expect(countUsageThisMonth(user.id, "interactive_browser")).toBe(0);

    // The released slot allows a fresh reservation.
    const { sessionId: second } = await createdSession(user);
    expect(getSessionById(second)!.status).toBe("CREATED");
  });
});

describe("admission control (concurrency and global capacity)", () => {
  it("applies per-user concurrency as retryable queue backpressure", async () => {
    const user = makeUser();
    const first = await startReadySession(driver, user); // free plan: concurrency 1

    const second = await createdSession(user);
    const queued = startInteractiveSession(user.id, second.sessionId, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    let capacityError: AppError | null = null;
    try {
      await enqueueAndHandleStart(queued.id, user.id);
    } catch (error) {
      capacityError = error as AppError;
    }
    expect(capacityError).not.toBeNull();
    expect(capacityError!.code).toBe("BROWSER_SESSION_LIMIT");
    expect((capacityError as unknown as { retryable?: boolean }).retryable).toBe(true);
    expect(getSessionById(queued.id)!.status).toBe("QUEUED");
    expect(getSessionById(first.sessionId)!.status).toBe("READY");

    // Freeing the slot lets the queued start succeed on retry.
    await stopInteractiveSession(user.id, first.sessionId, driver);
    await enqueueAndHandleStart(queued.id, user.id);
    expect(getSessionById(queued.id)!.status).toBe("READY");
  });

  it("enforces the deployment-wide global session cap across users", async () => {
    harness.teardown();
    harness = setupHarness({ INTERACTIVE_BROWSER_MAX_GLOBAL: "1" });
    driver = new FakeDriver();
    const first = await startReadySession(driver, makeUser());

    const secondUser = makeUser();
    const second = await createdSession(secondUser);
    const queued = startInteractiveSession(secondUser.id, second.sessionId, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    await expect(enqueueAndHandleStart(queued.id, secondUser.id)).rejects.toMatchObject({
      code: "BROWSER_SESSION_LIMIT",
    });
    expect(getSessionById(first.sessionId)!.status).toBe("READY");
  });
});

describe("failure and recovery paths clean everything up", () => {
  it("marks a session FAILED when its container crashes, and removes the remains", async () => {
    const { sessionId } = await startReadySession(driver);
    const runtime = parseRuntimeInfo(getSessionById(sessionId)!)!;

    driver.markCrashed(runtime.containerId); // the container vanished
    const report = await runInteractiveSweep(driver);
    expect(report.failedOrphans).toBeGreaterThanOrEqual(1);

    const failed = getSessionById(sessionId)!;
    expect(failed.status).toBe("FAILED");
    expect(failed.stop_reason).toBe("browser_crash");
    expect(driver.removedContainers).toContain(runtime.containerId);
    expect(existsSync(runtime.tempDir)).toBe(false);
    expect(listSessionEvents(sessionId).map((event) => event.type)).toContain("session_stopped");
  });

  it("fails closed with package_unavailable when the bound package is deleted mid-session", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const row = getSessionById(sessionId)!;
    const runtime = parseRuntimeInfo(row)!;

    await deleteOwnedPackage(user.id, row.package_id!);
    await expect(reloadExtension(user.id, sessionId)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" });

    const failed = getSessionById(sessionId)!;
    expect(failed.status).toBe("FAILED");
    expect(failed.stop_reason).toBe("package_unavailable");
    expect(driver.removedContainers).toContain(runtime.containerId);
    expect(existsSync(runtime.tempDir)).toBe(false);
  });

  it("refuses to start when the stored package no longer matches its recorded SHA-256", async () => {
    const user = makeUser();
    const { sessionId } = await createdSession(user);
    const row = getSessionById(sessionId)!;
    const { getDb } = await import("@/lib/db/client");
    getDb().prepare("UPDATE interactive_browser_sessions SET package_sha256 = ? WHERE id = ?").run("0".repeat(64), sessionId);
    expect(row.package_sha256).toHaveLength(64);

    const queued = startInteractiveSession(user.id, sessionId, (r) => ({ jobId: enqueueStart(r.id, r.user_id).id }));
    await expect(enqueueAndHandleStart(queued.id, user.id)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" });

    const failed = getSessionById(sessionId)!;
    expect(failed.status).toBe("FAILED");
    expect(failed.stop_reason).toBe("package_hash_mismatch");
    // The mismatch is detected before any container or extraction happens.
    expect(driver.createdSources).toHaveLength(0);
    expect(driver.removedContainers).toHaveLength(0);
  });
});

describe("keepalive rate limiting", () => {
  it("throttles an unreasonably chatty client", async () => {
    harness.teardown();
    harness = setupHarness({ INTERACTIVE_BROWSER_KEEPALIVE_PER_MIN: "3" });
    driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const cookie = sessionCookieFor(user.id);
    const call = () =>
      keepaliveRoute(
        new NextRequest(`http://localhost:3000/api/browser-sessions/${sessionId}/keepalive`, {
          method: "POST",
          headers: { host: "localhost:3000", cookie },
        }),
        { params: Promise.resolve({ id: sessionId }) },
      );
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await call();
      statuses.push(response.status);
    }
    expect(statuses[0]).toBe(200);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    // The hard deadline is untouched by keepalives (tested in input-and-navigation).
  });
});
