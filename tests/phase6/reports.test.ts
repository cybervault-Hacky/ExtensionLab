import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as createReportRoute } from "@/app/api/reports/route";
import { createSession } from "@/lib/db/repositories/sessions";
import { createExtension } from "@/lib/db/repositories/extensions";
import { createSnapshot } from "@/lib/db/repositories/snapshots";
import { createTestRun, finalizeTestRunWithoutResults, saveTestRunFinal } from "@/lib/db/repositories/test-runs";
import { getOwnedReport } from "@/lib/db/repositories/reports";
import { createPublicReportView, createReportView } from "@/lib/reports/views";
import { generateAuthToken, hashToken } from "@/lib/auth/tokens";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { setupHarness, makeUser, type Harness } from "./helpers";

/**
 * Reports must describe runtime status honestly: a run whose sandbox never
 * executed anything is "not executed" (no runtime score, overall = static
 * health) rather than a fabricated 0/100, and reports cannot be generated
 * from a run that is still active.
 */
describe("report runtime status honesty", () => {
  let harness: Harness;
  let cookie: string;
  let userId: string;
  let extensionId: string;

  const analysis = {
    sourceName: "fixture.zip",
    metadata: { name: "Fixture", version: "1.0.0" },
    manifest: { manifestVersion: 3 },
    issues: [{ id: "i1", severity: "info", title: "Example", description: "Example finding" }],
    permissions: [],
    healthScore: { total: 88, categories: [] },
  };

  beforeAll(() => {
    harness = setupHarness();
    const user = makeUser();
    userId = user.id;
    const token = generateAuthToken();
    createSession({ userId, tokenHash: hashToken(token) });
    cookie = `${SESSION_COOKIE}=${token}`;
    const extension = createExtension({
      userId,
      name: "Fixture",
      version: "1.0.0",
      manifestVersion: "v3",
      sourceName: "fixture.zip",
      healthScore: 88,
    });
    extensionId = extension.id;
    createSnapshot({ extensionId, healthScore: 88, manifestVersion: "v3", analysisJson: JSON.stringify(analysis) });
  });

  afterAll(() => harness.teardown());

  function post(body: Record<string, unknown>): Promise<Response> {
    return createReportRoute(
      new NextRequest("http://localhost:3000/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "localhost:3000" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("rejects report generation while the run is still active", async () => {
    const run = createTestRun({ userId, extensionId, status: "queued", stage: "Queued", total: 7 });
    const response = await post({ extensionId, testRunId: run.id });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).not.toMatch(/docker|container|\/tmp|\/home/i);
  });

  it("gives an infrastructure-error run no runtime score and keeps the static score as overall", async () => {
    const run = createTestRun({ userId, extensionId, status: "queued", stage: "Queued", total: 7 });
    finalizeTestRunWithoutResults({
      id: run.id,
      status: "failed",
      outcome: "INFRASTRUCTURE_ERROR",
      errorCode: "SANDBOX_UNAVAILABLE",
      reason: "The isolated browser environment is currently unavailable.",
    });

    const response = await post({ extensionId, testRunId: run.id });
    expect(response.status).toBe(201);
    const { report } = (await response.json()) as { report: { id: string } };

    const stored = getOwnedReport(userId, report.id);
    expect(stored).not.toBeNull();
    expect(stored!.runtime_score).toBeNull();
    expect(stored!.health_score).toBe(88);
    expect(stored!.overall_score).toBe(88);
    expect(stored!.summary).toContain("not executed");
    expect(stored!.summary).not.toContain("0/100");

    const payload = JSON.parse(stored!.report_json) as { runtimeTests: Record<string, unknown> };
    expect(payload.runtimeTests.runtimeStatus).toBe("not-executed");
    expect(payload.runtimeTests.outcome).toBe("INFRASTRUCTURE_ERROR");
    expect(payload.runtimeTests.errorCode).toBe("SANDBOX_UNAVAILABLE");
    expect(payload.runtimeTests.score).toBeNull();

    const ownerView = createReportView(stored!, payload as unknown as Record<string, unknown>) as {
      runtimeTests: { status: string; outcome: string | null; score: number | null; reason: string | null };
    };
    expect(ownerView.runtimeTests.status).toBe("not-executed");
    expect(ownerView.runtimeTests.score).toBeNull();
    expect(ownerView.runtimeTests.reason).toContain("unavailable");

    const publicView = createPublicReportView(stored!, payload as unknown as Record<string, unknown>) as {
      runtimeStatus: string;
      tests: unknown;
      runtimeScore: number | null;
      staticScore: number;
    };
    expect(publicView.runtimeStatus).toBe("not-executed");
    expect(publicView.tests).toBeNull();
    expect(publicView.runtimeScore).toBeNull();
    expect(publicView.staticScore).toBe(88);
    expect(JSON.stringify(publicView)).not.toMatch(/storage_key|storageKey|container|docker|\/tmp\/|runId|user_id/i);
  });

  it("keeps real runtime scores for executed runs and averages them into the overall score", async () => {
    const run = createTestRun({ userId, extensionId, status: "queued", stage: "Queued", total: 2 });
    saveTestRunFinal({
      id: run.id,
      status: "completed",
      score: 50,
      total: 2,
      passed: 1,
      failed: 1,
      warnings: 0,
      skipped: 0,
      timeout: 0,
      errorCount: 0,
      completedAt: Date.now(),
      resultJson: JSON.stringify({
        summary: { total: 2, passed: 1, failed: 1 },
        results: [],
        outcome: "FAILED",
        runtime: { status: "executed", sandboxStarted: true },
      }),
      diagnosticsJson: null,
      eventsJson: null,
      outcome: "FAILED",
      errorCode: null,
      reason: null,
    });

    const response = await post({ extensionId, testRunId: run.id });
    expect(response.status).toBe(201);
    const { report } = (await response.json()) as { report: { id: string } };
    const stored = getOwnedReport(userId, report.id)!;
    expect(stored.runtime_score).toBe(50);
    expect(stored.overall_score).toBe(Math.round((88 + 50) / 2));

    const payload = JSON.parse(stored.report_json) as Record<string, unknown>;
    const view = createReportView(stored, payload) as { runtimeTests: { status: string; outcome: string | null } };
    expect(view.runtimeTests.status).toBe("executed");
    expect(view.runtimeTests.outcome).toBe("FAILED");
  });
});
