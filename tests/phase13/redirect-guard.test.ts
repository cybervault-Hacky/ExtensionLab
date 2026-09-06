import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { navigateSession, stopInteractiveSession } from "@/lib/interactive/service";
import { getSessionById, listSessionEvents } from "@/lib/db/repositories/browser-sessions";
import { FakeDriver, fixtureZip, makeUser, setupPhase13Harness, startReadySession, waitFor, type Harness } from "./helpers";
import { enqueueStart, fakeContext } from "../phase11/helpers";
import { createInteractiveBrowserStartHandler } from "@/lib/jobs/handlers/interactive-browser";
import { createInteractiveSession, startInteractiveSession } from "@/lib/interactive/service";
import { getJobById } from "@/lib/db/repositories/jobs";
import { setInteractiveDriverForTests } from "@/lib/interactive/service";
import { storeExtensionPackage } from "@/lib/packages/service";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness();
});

afterEach(() => {
  harness.teardown();
});

async function readySessionWithRedirectDriver(redirectTo: string): Promise<{ user: ReturnType<typeof makeUser>; sessionId: string }> {
  const driver = new FakeDriver({ redirectTo });
  setInteractiveDriverForTests(driver);
  const user = makeUser();
  const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
  const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
  const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
  const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
  await handler.handle(fakeContext<"INTERACTIVE_BROWSER_START">(getJobById(queued.job_id!)!, { sessionId: queued.id }));
  await waitFor(() => getSessionById(queued.id)!.status === "READY");
  return { user, sessionId: queued.id };
}

/**
 * §33: URL validation BEFORE navigation AND again AFTER redirects. A public
 * URL that 30x-redirects to an internal host must be blocked server-side.
 */
describe("Phase 13 §33: post-redirect URL re-validation", () => {
  it("blocks a navigation whose redirect lands on the cloud metadata address", async () => {
    const { user, sessionId } = await readySessionWithRedirectDriver("http://169.254.169.254/latest/meta-data/");
    await expect(
      navigateSession(user.id, sessionId, { op: "navigate", url: "https://example.com/launch" }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });

    // The blocked redirect is recorded honestly in the session event log.
    const blocked = listSessionEvents(sessionId).find((event) => {
      try {
        return (JSON.parse(event.metadata_json ?? "{}") as { blocked?: boolean }).blocked === true;
      } catch {
        return false;
      }
    });
    expect(blocked).toBeTruthy();
    expect(blocked!.message).toMatch(/redirected|blocked/i);
    // The session survives (the user can navigate elsewhere).
    expect(getSessionById(sessionId)!.status).not.toBe("STOPPED");
    await stopInteractiveSession(user.id, sessionId, new FakeDriver()).catch(() => undefined);
  });

  it("blocks a redirect to loopback even though the requested URL is public", async () => {
    const { user, sessionId } = await readySessionWithRedirectDriver("http://127.0.0.1:9225/json/list");
    await expect(
      navigateSession(user.id, sessionId, { op: "navigate", url: "https://example.com/" }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("still allows normal navigations and records the effective URL", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const row = await navigateSession(user.id, sessionId, { op: "navigate", url: "https://example.com/" });
    expect(row.current_url).toContain("example.com");
    expect(getSessionById(sessionId)!.status).not.toBe("STOPPED");
  });
});
