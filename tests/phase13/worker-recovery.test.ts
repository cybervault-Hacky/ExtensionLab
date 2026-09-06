import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  createInteractiveSession,
  startInteractiveSession,
  parseRuntimeInfo,
  setInteractiveDriverForTests,
} from "@/lib/interactive/service";
import { transitionSession, getSessionById } from "@/lib/db/repositories/browser-sessions";
import { getJobById } from "@/lib/db/repositories/jobs";
import { storeExtensionPackage } from "@/lib/packages/service";
import { createInteractiveBrowserStartHandler } from "@/lib/jobs/handlers/interactive-browser";
import { enqueueStart, fakeContext } from "../phase11/helpers";
import { FakeDriver, fixtureZip, makeUser, setupPhase13Harness, waitFor, type Harness } from "./helpers";

let harness: Harness;
let driver: FakeDriver;

beforeEach(() => {
  harness = setupPhase13Harness();
  driver = new FakeDriver();
  setInteractiveDriverForTests(driver);
});

afterEach(() => {
  harness.teardown();
});

/**
 * §20/§21/§23: at-least-once delivery with idempotent execution. A worker that
 * dies mid-start leaves a stale STARTING session and an orphaned container;
 * re-delivery must recover exactly once — no duplicate sessions, no duplicate
 * containers.
 */
describe("Phase 13 §23: worker failure mid-start recovers idempotently", () => {
  it("re-claims a stale STARTING session, removes the leftover container, starts once", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));

    // Simulate worker death mid-start: a container was created and runtime info
    // stamped, but the job never completed (lease expires; job re-delivered).
    const handle = await driver.create(queued.id, "/tmp/pkg.zip", "token-crash", { ownerKind: "interactive", sessionId: queued.id });
    transitionSession(queued.id, ["QUEUED", "STARTING"], "STARTING", {
      runtimeJson: JSON.stringify({
        containerId: handle.containerId,
        controlPort: handle.controlPort,
        runnerToken: "token-crash",
      }),
    });
    const orphanId = handle.containerId;
    expect(driver.ownedLabels.has(orphanId)).toBe(true);

    // Re-delivery: a new worker runs the same job id.
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });
    const result = await handler.handle(
      fakeContext<"INTERACTIVE_BROWSER_START">(getJobById(queued.job_id!)!, { sessionId: queued.id }),
    );

    await waitFor(() => getSessionById(queued.id)!.status === "READY");
    expect(getSessionById(queued.id)!.status).toBe("READY");
    expect(result).toBeTruthy();

    // Exactly one live container: the stale one was removed, not reused.
    expect(driver.removedContainers).toContain(orphanId);
    const runtime = parseRuntimeInfo(getSessionById(queued.id)!)!;
    expect(runtime.containerId).not.toBe(orphanId);
    expect(driver.ownedLabels.has(orphanId)).toBe(false);
    expect(driver.ownedLabels.has(runtime.containerId)).toBe(true);
    const liveContainers = [...driver.ownedLabels.keys()];
    expect(liveContainers).toHaveLength(1);
  });

  it("re-delivery after a successful start is a no-op (no second container)", async () => {
    const user = makeUser();
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    const queued = startInteractiveSession(user.id, created.id, (row) => ({ jobId: enqueueStart(row.id, row.user_id).id }));
    const handler = createInteractiveBrowserStartHandler({ driver, sandboxProbe: async () => ({ available: true }) });

    await handler.handle(fakeContext<"INTERACTIVE_BROWSER_START">(getJobById(queued.job_id!)!, { sessionId: queued.id }));
    await waitFor(() => getSessionById(queued.id)!.status === "READY");
    const afterFirst = driver.ownedLabels.size;

    // Duplicate delivery of the same job.
    const again = await handler.handle(
      fakeContext<"INTERACTIVE_BROWSER_START">(getJobById(queued.job_id!)!, { sessionId: queued.id }),
    );
    expect((again as { skipped?: boolean }).skipped).toBe(true);
    expect(driver.ownedLabels.size).toBe(afterFirst);
  });
});
