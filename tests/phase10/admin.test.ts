import { NextRequest, NextResponse } from "next/server";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { GET as adminOverview } from "@/app/api/admin/route";
import { POST as retryRoute } from "@/app/api/admin/jobs/[id]/retry/route";
import { POST as cancelRoute } from "@/app/api/admin/jobs/[id]/cancel/route";
import { enqueueJob } from "@/lib/jobs/queue";
import { completeJob, failJob, getJobById, JOB_TYPES } from "@/lib/db/repositories/jobs";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness({ ADMIN_API_ENABLED: "true", ADMIN_API_TOKEN: "ops-secret-token" });
});

afterEach(() => {
  harness.teardown();
});

function adminRequest(url: string, token: string | null = "ops-secret-token"): NextRequest {
  return new NextRequest(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

describe("internal admin abstraction", () => {
  it("fails closed and invisibly when disabled", async () => {
    const { resetConfigCache } = await import("@/lib/config/env");
    delete process.env.ADMIN_API_ENABLED;
    resetConfigCache();
    try {
      const response = (await adminOverview(adminRequest("https://x/api/admin"))) as NextResponse;
      expect(response.status).toBe(404);
    } finally {
      process.env.ADMIN_API_ENABLED = "true";
      resetConfigCache();
    }
  });

  it("rejects wrong or missing tokens (constant-time path)", async () => {
    expect(((await adminOverview(adminRequest("https://x/api/admin", null))) as NextResponse).status).toBe(401);
    expect(((await adminOverview(adminRequest("https://x/api/admin", "wrong-token"))) as NextResponse).status).toBe(401);
  });

  it("serves queue depth and worker health with the right token", async () => {
    const owner = makeUser();
    enqueueJob({ type: "ANALYSIS", userId: owner.id, organizationId: null, idempotencyKey: "adm-1", payload: { packageId: "pkg_a", extensionId: null } });
    const response = (await adminOverview(adminRequest("https://x/api/admin"))) as NextResponse;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { queue: Record<string, number>; workers: { live: number } };
    expect(body.queue.queued ?? 0).toBeGreaterThanOrEqual(1);
    expect(typeof body.workers.live).toBe("number");
  });

  it("retries failed jobs (audited) and refuses non-failed ones", async () => {
    const owner = makeUser();
    const job = enqueueJob({ type: "ANALYSIS", userId: owner.id, organizationId: null, idempotencyKey: "adm-2", payload: { packageId: "pkg_b", extensionId: null } }).job;
    failJob(job.id, "JOB_TIMEOUT", "boom");
    const ok = (await retryRoute(adminRequest("https://x/api/admin/jobs/x/retry"), { params: Promise.resolve({ id: job.id }) })) as NextResponse;
    expect(ok.status).toBe(200);
    expect(["queued", "retrying"]).toContain(getJobById(job.id)?.status);
    // Non-failed jobs cannot be retried.
    const queued = enqueueJob({ type: "ANALYSIS", userId: owner.id, organizationId: null, idempotencyKey: "adm-3", payload: { packageId: "pkg_c", extensionId: null } }).job;
    const refusal = (await retryRoute(adminRequest("https://x/api/admin/jobs/x/retry"), { params: Promise.resolve({ id: queued.id }) })) as NextResponse;
    expect(refusal.status).toBe(400);
  });

  it("cancels queued jobs immediately, running jobs cooperatively", async () => {
    const owner = makeUser();
    const queued = enqueueJob({ type: "ANALYSIS", userId: owner.id, organizationId: null, idempotencyKey: "adm-4", payload: { packageId: "pkg_d", extensionId: null } }).job;
    const cancelled = (await cancelRoute(adminRequest("https://x/api/admin/jobs/x/cancel"), { params: Promise.resolve({ id: queued.id }) })) as NextResponse;
    expect(cancelled.status).toBe(200);
    expect(getJobById(queued.id)?.status).toBe("cancelled");

    const running = enqueueJob({ type: "ANALYSIS", userId: owner.id, organizationId: null, idempotencyKey: "adm-5", payload: { packageId: "pkg_e", extensionId: null } }).job;
    void JOB_TYPES;
    void completeJob;
    // Force a running state for the cooperative-cancel path.
    const { claimNextJob } = await import("@/lib/db/repositories/jobs");
    const claimed = claimNextJob({ workerId: "w-admin", types: JOB_TYPES, leaseMs: 60_000 });
    expect(claimed?.id).toBe(running.id);
    const cooperative = (await cancelRoute(adminRequest("https://x/api/admin/jobs/x/cancel"), { params: Promise.resolve({ id: running.id }) })) as NextResponse;
    expect(cooperative.status).toBe(200);
    const after = getJobById(running.id);
    expect(after?.cancel_requested_at !== null || after?.status === "cancelled").toBe(true);
  });

  it("audit rows are written for admin actions", async () => {
    const owner = makeUser();
    const job = enqueueJob({ type: "ANALYSIS", userId: owner.id, organizationId: null, idempotencyKey: "adm-6", payload: { packageId: "pkg_f", extensionId: null } }).job;
    failJob(job.id, "JOB_TIMEOUT", null);
    await retryRoute(adminRequest("https://x/api/admin/jobs/x/retry"), { params: Promise.resolve({ id: job.id }) });
    const { getDb } = await import("@/lib/db/client");
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'admin_job_retry'").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
