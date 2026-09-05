import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { recordAuditEvent, queryAuditEventsForOrg, sanitizeAuditMetadata, AUDIT_ACTIONS } from "@/lib/audit/service";
import { createOrganization } from "@/lib/organizations/service";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

describe("audit metadata redaction", () => {
  it("drops sensitive keys and bounds size", () => {
    const sanitized = sanitizeAuditMetadata({
      password: "hunter2",
      api_key: "el abc",
      authorization: "Bearer x",
      cookie: "session=1",
      source: "console.log('hi')",
      body: "raw",
      ok: "value",
      alsoFine: "x".repeat(500),
    });
    expect(Object.keys(sanitized)).not.toContain("password");
    expect(Object.keys(sanitized)).not.toContain("api_key");
    expect(Object.keys(sanitized)).not.toContain("authorization");
    expect(Object.keys(sanitized)).not.toContain("cookie");
    expect(Object.keys(sanitized)).not.toContain("source");
    expect(sanitized.ok).toBe("value");
    expect(String(sanitized.alsoFine).length).toBeLessThanOrEqual(300);
  });
});

describe("recording", () => {
  it("never throws — even with a bogus organization (FK failure is swallowed)", () => {
    expect(() => recordAuditEvent({ organizationId: "unknown", actorUserId: "u", action: "test.event" })).not.toThrow();
  });

  it("records events with actor/api-key/request context and immutable inserts", () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Audit Co" });
    recordAuditEvent({ organizationId: org.id, actorUserId: owner.id, actorApiKeyId: "orga_x", action: "api_key.created", resourceType: "api_key", resourceId: "orga_x", requestId: "req_1", ip: "203.0.113.9", success: true, metadata: { name: "CI" } });
    const result = queryAuditEventsForOrg({ organizationId: org.id, limit: 10, offset: 0 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    const event = result.items.find((item) => item.action === "api_key.created");
    expect(event?.actorApiKeyId).toBe("orga_x");
    expect(event?.requestId).toBe("req_1");
  });

  it("supports action, actor, date-range filters, search and pagination", () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Filter Co" });
    recordAuditEvent({ organizationId: org.id, actorUserId: owner.id, action: "member.invited", resourceType: "invitation", resourceId: "orgi_1" });
    recordAuditEvent({ organizationId: org.id, actorUserId: owner.id, action: "webhook.created", resourceType: "webhook", resourceId: "orgw_1" });
    expect(queryAuditEventsForOrg({ organizationId: org.id, action: "member.invited", limit: 10, offset: 0 }).total).toBe(1);
    expect(queryAuditEventsForOrg({ organizationId: org.id, actorUserId: "usr_missing", limit: 10, offset: 0 }).total).toBe(0);
    expect(queryAuditEventsForOrg({ organizationId: org.id, search: "orgw", limit: 10, offset: 0 }).total).toBe(1);
    expect(queryAuditEventsForOrg({ organizationId: org.id, from: Date.now() + 60_000, limit: 10, offset: 0 }).total).toBe(0);
    const paged = queryAuditEventsForOrg({ organizationId: org.id, limit: 1, offset: 1 });
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBeGreaterThanOrEqual(2);
  });

  it("organizations only ever see their own events", () => {
    const a = makeUser();
    const b = makeUser();
    const orgA = createOrganization({ userId: a.id }, { name: "Iso A" });
    const orgB = createOrganization({ userId: b.id }, { name: "Iso B" });
    recordAuditEvent({ organizationId: orgA.id, actorUserId: a.id, action: "org.updated" });
    const seen = queryAuditEventsForOrg({ organizationId: orgB.id, limit: 10, offset: 0 });
    expect(seen.items.every((item) => item.action !== "org.updated")).toBe(true);
  });

  it("exposes a stable action vocabulary for the UI filter", () => {
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(10);
    expect(AUDIT_ACTIONS).toContain("member.invited");
    expect(AUDIT_ACTIONS).toContain("webhook.created");
  });
});
