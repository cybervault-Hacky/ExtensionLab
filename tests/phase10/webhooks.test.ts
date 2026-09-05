import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { generateWebhookSecret, signWebhookPayload, verifyWebhookSignature } from "@/lib/webhooks/signing";
import { validateWebhookDestination } from "@/lib/webhooks/destination";
import { dispatchOrganizationEvent, WEBHOOK_EVENTS } from "@/lib/webhooks/dispatch";
import { createWebhook, listOrganizationWebhooks } from "@/lib/webhooks/service";
import { processWebhookDelivery, sweepDueWebhookDeliveries } from "@/lib/webhooks/deliver";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { getDb } from "@/lib/db/client";
import { makeUser, setupHarness, type Harness } from "./helpers";
import { resetConfigCache } from "@/lib/config/env";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
  harness.teardown();
});

function proOrg(name = "Webhook Co"): { org: string; owner: string } {
  const owner = makeUser();
  const org = createOrganization({ userId: owner.id }, { name });
  setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 10 });
  return { org: org.id, owner: owner.id };
}

describe("signing", () => {
  it("produces and verifies deterministic HMAC signatures over ts.event.body", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_/);
    const body = JSON.stringify({ id: "evt_1", type: "package.created" });
    const signature = signWebhookPayload(secret, 1700000000, "evt_1", body);
    expect(signature).toBe(`t=1700000000,e=evt_1,v1=${signature.split("v1=")[1]}`);
    expect(signature.split("v1=")[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyWebhookSignature(secret, 1700000000, "evt_1", body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, 1700000001, "evt_1", body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, 1700000000, "evt_2", body, signature)).toBe(false);
    expect(verifyWebhookSignature("whsec_other", 1700000000, "evt_1", body, signature)).toBe(false);
  });
});

describe("destination validation (SSRF)", () => {
  // These cases need the production posture: test env intentionally allows
  // private destinations so local e2e webhooks can be exercised.
  beforeEach(() => {
    process.env.APP_ENV = "development";
    resetConfigCache();
  });
  afterEach(() => {
    process.env.APP_ENV = "test";
    resetConfigCache();
  });

  it("rejects non-HTTPS, credentials, and private/reserved targets", async () => {
    expect((await validateWebhookDestination("http://example.com/hook")).ok).toBe(false);
    expect((await validateWebhookDestination("https://user:pass@example.com/hook")).ok).toBe(false);
    expect((await validateWebhookDestination("https://localhost/hook")).ok).toBe(false);
    expect((await validateWebhookDestination("https://127.0.0.1/hook")).ok).toBe(false);
    expect((await validateWebhookDestination("https://169.254.169.254/latest/meta-data")).ok).toBe(false);
    expect((await validateWebhookDestination("https://10.1.2.3/hook")).ok).toBe(false);
    expect((await validateWebhookDestination("https://192.168.0.1/hook")).ok).toBe(false);
    expect((await validateWebhookDestination("https://172.16.5.4/hook")).ok).toBe(false);
    expect((await validateWebhookDestination("ftp://example.com")).ok).toBe(false);
    expect((await validateWebhookDestination("not a url")).ok).toBe(false);
  });

  it("accepts ordinary public HTTPS destinations", async () => {
    const verdict = await validateWebhookDestination("https://example.com/hooks/extensionlab");
    expect(verdict.ok).toBe(true);
  });
});

describe("dispatch + delivery", () => {
  it("dispatch persists one delivery per subscribed webhook and enqueues jobs; no subscribers is a no-op", async () => {
    const { org, owner } = proOrg();
    const { createWebhook: create } = await import("@/lib/webhooks/service");
    await create({ userId: owner, organizationId: org }, { url: "https://example.com/hook", events: ["package.created"] });
    const eventId = dispatchOrganizationEvent(org, "package.created", { packageId: "pkg_1" });
    expect(eventId).toMatch(/^evt_/);
    const deliveries = getDb().prepare("SELECT * FROM organization_webhook_deliveries WHERE organization_id = ?").all(org) as unknown as Array<{ event_id: string; status: string }>;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].event_id).toBe(eventId);
    const jobs = getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'WEBHOOK_DELIVERY' AND organization_id = ?").get(org) as { n: number };
    expect(jobs.n).toBe(1);
    expect(dispatchOrganizationEvent(org, "member.joined", { userId: "u" })).toBeNull();
  });

  it("delivery succeeds on 2xx and never reads the response body", async () => {
    const { org, owner } = proOrg();
    await createWebhook({ userId: owner, organizationId: org }, { url: "https://example.com/ok", events: ["*"] });
    dispatchOrganizationEvent(org, "report.created", { reportId: "rep_1" });
    const delivery = getDb().prepare("SELECT id FROM organization_webhook_deliveries WHERE organization_id = ?").get(org) as { id: string };
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await processWebhookDelivery(delivery.id);
    expect(outcome).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("retries with backoff then dead-letters after max attempts", async () => {
    const { org, owner } = proOrg();
    await createWebhook({ userId: owner, organizationId: org }, { url: "https://example.com/flaky", events: ["*"] });
    dispatchOrganizationEvent(org, "report.created", { reportId: "rep_2" });
    const deliveryId = (getDb().prepare("SELECT id FROM organization_webhook_deliveries WHERE organization_id = ?").get(org) as { id: string }).id;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    let lastOutcome = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      lastOutcome = await processWebhookDelivery(deliveryId);
      if (lastOutcome === "dead_letter") break;
      // The retry state machine reschedules; make it due immediately.
      getDb().prepare("UPDATE organization_webhook_deliveries SET next_attempt_at = 0 WHERE id = ?").run(deliveryId);
    }
    expect(lastOutcome).toBe("dead_letter");
    const row = getDb().prepare("SELECT status, attempts FROM organization_webhook_deliveries WHERE id = ?").get(deliveryId) as { status: string; attempts: number };
    expect(row.status).toBe("dead_letter");
    expect(row.attempts).toBeGreaterThanOrEqual(6);
    vi.unstubAllGlobals();
  });

  it("sweep reschedules due-but-pending deliveries (crash recovery)", async () => {
    const { org, owner } = proOrg();
    await createWebhook({ userId: owner, organizationId: org }, { url: "https://example.com/x", events: ["*"] });
    dispatchOrganizationEvent(org, "report.created", { reportId: "rep_3" });
    getDb().prepare("UPDATE organization_webhook_deliveries SET next_attempt_at = 0 WHERE organization_id = ?").run(org);
    const count = await sweepDueWebhookDeliveries(10);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("webhook CRUD validates events and limits; secret is shown once and never listed", async () => {
    const { org, owner } = proOrg();
    await expect(createWebhook({ userId: owner, organizationId: org }, { url: "https://example.com/hook", events: [] })).rejects.toThrow();
    const created = await createWebhook({ userId: owner, organizationId: org }, { url: "https://example.com/hook", events: WEBHOOK_EVENTS.slice(0, 3) });
    expect(created.secret).toMatch(/^whsec_/);
    const listed = listOrganizationWebhooks(org);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });
});
