import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { runInteractiveSweep } from "@/lib/interactive/sweep";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { FakeDriver, makeUser, setupPhase13Harness, startReadySession, type Harness } from "./helpers";

let harness: Harness;
let driver: FakeDriver;

beforeEach(() => {
  harness = setupPhase13Harness();
  driver = new FakeDriver();
});

afterEach(() => {
  harness.teardown();
});

/** §15/§16: label-scoped container reconciliation — never blind deletion. */
describe("Phase 13 §15: orphaned container reconciliation", () => {
  it("removes ExtensionLab-owned interactive containers whose session is gone", async () => {
    const { user, sessionId } = await startReadySession(driver);
    const runtime = (await import("@/lib/interactive/service")).parseRuntimeInfo(getSessionById(sessionId)!)!;

    // The session dies (and its container is destroyed by the normal path).
    const { stopInteractiveSession } = await import("@/lib/interactive/service");
    await stopInteractiveSession(user.id, sessionId, driver);
    expect(driver.ownedLabels.has(runtime.containerId)).toBe(false); // normal cleanup removed the label too? if not, reconcile below

    // Simulate the crash path instead: container left behind with no session.
    driver.ownedLabels.set("fakecontainer_ghost", {
      name: "extensionlab-ghost",
      labels: {
        "extensionlab.environment": "test",
        "extensionlab.session": "sess_missing",
        "extensionlab.browser": "chromium",
        "extensionlab.owner": "interactive",
      },
      createdAt: Date.now() - 10 * 60_000,
    });

    const report = await runInteractiveSweep(driver);
    expect(report.reconciledContainers).toBeGreaterThanOrEqual(1);
    expect(driver.removedContainers).toContain("fakecontainer_ghost");
  });

  it("NEVER touches containers belonging to another environment/deployment", async () => {
    driver.ownedLabels.set("fakecontainer_foreign", {
      name: "extensionlab-prod-xyz",
      labels: {
        "extensionlab.environment": "production",
        "extensionlab.session": "sess_prod",
        "extensionlab.browser": "chromium",
        "extensionlab.owner": "interactive",
      },
      createdAt: Date.now() - 60 * 60_000,
    });
    const report = await runInteractiveSweep(driver);
    expect(driver.removedContainers).not.toContain("fakecontainer_foreign");
    expect(report.reconciledContainers).toBe(0);
  });

  it("keeps containers for live sessions", async () => {
    const { sessionId } = await startReadySession(driver);
    const runtime = (await import("@/lib/interactive/service")).parseRuntimeInfo(getSessionById(sessionId)!)!;
    const report = await runInteractiveSweep(driver);
    expect(driver.removedContainers).not.toContain(runtime.containerId);
    expect(report.reconciledContainers).toBe(0);
  });

  it("graces containers for sessions still starting (no mid-start kill)", async () => {
    const user = makeUser();
    const { storeExtensionPackage } = await import("@/lib/packages/service");
    const { fixtureZip } = await import("./helpers");
    const stored = await storeExtensionPackage({ userId: user.id, bytes: await fixtureZip(), fileName: "ext.zip" });
    const { createInteractiveSession, startInteractiveSession } = await import("@/lib/interactive/service");
    const created = createInteractiveSession(user, { userId: user.id, packageId: stored.package.id });
    startInteractiveSession(user.id, created.id, (row) => ({ jobId: `j-${row.id}` })); // QUEUED, no container yet
    driver.ownedLabels.set("fakecontainer_starting", {
      name: "extensionlab-starting",
      labels: {
        "extensionlab.environment": "test",
        "extensionlab.session": created.id,
        "extensionlab.browser": "chromium",
        "extensionlab.owner": "interactive",
      },
      createdAt: Date.now() - 1000, // just created
    });
    const report = await runInteractiveSweep(driver);
    expect(report.reconciledContainers).toBe(0);
    expect(driver.removedContainers).not.toContain("fakecontainer_starting");
    void makeUser;
  });
});
