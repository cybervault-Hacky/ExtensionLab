import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  attachSessionEvidenceToReportById,
  captureScreenshotArtifact,
  listSessionEvidenceViews,
  removeSessionEvidence,
  saveSessionEvidence,
} from "@/lib/interactive/service";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { getReportById } from "@/lib/db/repositories/reports";
import { FakeDriver, makeUser, setupPhase12Harness, startReadySession, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase12Harness();
});

afterEach(() => {
  harness.teardown();
});

describe("Phase 12 §57: evidence records reference runtime data, never copy it", () => {
  it("saves console evidence with a redacted, bounded summary and safe metadata", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const view = saveSessionEvidence(user.id, sessionId, {
      kind: "console",
      refId: "ring_123",
      label: "Login error",
      detail: "GET /login?password=hunter2-not-real failed with TypeError",
      metadata: { source: "page", "bad-key!": "dropped", level: "error" },
    });
    expect(view.kind).toBe("console");
    expect(view.refId).toBe("ring_123");
    expect(view.summary).toContain("REDACTED");
    expect(view.summary).not.toContain("hunter2-not-real");
    expect(view.summary.length).toBeLessThanOrEqual(300);
    expect(view.metadata).toEqual({ source: "page", level: "error" }); // invalid key dropped
    expect(view.packageSha256).toBe(getSessionById(sessionId)!.package_sha256);
    expect(listSessionEvidenceViews(user.id, sessionId)).toHaveLength(1);
  });

  it("rejects unknown kinds and cross-session access", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    expect(() =>
      saveSessionEvidence(user.id, sessionId, {
        kind: "wild" as never,
        detail: "x",
      }),
    ).toThrowError(/Unknown evidence kind/);
    const stranger = makeUser();
    expect(() => listSessionEvidenceViews(stranger.id, sessionId)).toThrowError();
  });

  it("screenshot evidence must reference a real session artifact", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    expect(() =>
      saveSessionEvidence(user.id, sessionId, { kind: "screenshot", refId: "does-not-exist", detail: "shot" }),
    ).toThrowError(/artifact does not exist/);
    const artifact = await captureScreenshotArtifact(user.id, sessionId, "proof");
    const view = saveSessionEvidence(user.id, sessionId, {
      kind: "screenshot",
      refId: artifact.id,
      detail: "Screenshot after crash",
    });
    expect(view.refId).toBe(artifact.id);
  });
});

describe("Phase 12 §57: server-side evidence quota", () => {
  let quotaHarness: Harness;

  beforeEach(() => {
    quotaHarness = setupPhase12Harness({ INTERACTIVE_BROWSER_MAX_EVIDENCE: "2" });
  });

  afterEach(() => {
    quotaHarness.teardown();
  });

  it("caps evidence per session regardless of caller", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    saveSessionEvidence(user.id, sessionId, { kind: "event", detail: "one" });
    saveSessionEvidence(user.id, sessionId, { kind: "event", detail: "two" });
    expect(() => saveSessionEvidence(user.id, sessionId, { kind: "event", detail: "three" })).toThrowError(
      /maximum/,
    );
  });
});

describe("Phase 12 §57: attach-to-report lifecycle", () => {
  it("attaches to a newly created report exactly once; attached evidence is immutable", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const saved = saveSessionEvidence(user.id, sessionId, { kind: "console", refId: "r1", detail: "boom" });

    const attached = attachSessionEvidenceToReportById(user.id, saved.id, null);
    expect(attached.reportId).toBeTruthy();
    const report = getReportById(attached.reportId!);
    expect(report).toBeTruthy();
    const reportJson = JSON.parse(report!.report_json) as {
      interactiveEvidence?: Array<{ evidenceId: string; kind: string }>;
    };
    expect(reportJson.interactiveEvidence?.[0]?.evidenceId).toBe(saved.id);

    // Re-attach and delete are both refused once part of a report.
    expect(() => attachSessionEvidenceToReportById(user.id, saved.id, null)).toThrowError(/already attached/);
    expect(() => removeSessionEvidence(user.id, saved.id)).toThrowError(/cannot be deleted/);
  });

  it("deletes unattached evidence on request", async () => {
    const driver = new FakeDriver();
    const { user, sessionId } = await startReadySession(driver);
    const saved = saveSessionEvidence(user.id, sessionId, { kind: "network", refId: "n1", detail: "GET /x 500" });
    removeSessionEvidence(user.id, saved.id);
    expect(listSessionEvidenceViews(user.id, sessionId)).toHaveLength(0);
  });
});
