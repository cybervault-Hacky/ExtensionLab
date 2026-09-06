import JSZip from "jszip";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { POST as postCreate } from "@/app/api/v1/browser-sessions/route";
import { GET as getStatus } from "@/app/api/v1/browser-sessions/[id]/route";
import { POST as postStop } from "@/app/api/v1/browser-sessions/[id]/stop/route";
import { createApiKey } from "@/lib/api-keys/service";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { queryAuditEventsForOrg } from "@/lib/audit/service";
import { storeExtensionPackage } from "@/lib/packages/service";
import { getSessionById } from "@/lib/db/repositories/browser-sessions";
import { getJobById } from "@/lib/db/repositories/jobs";
import { makeUser, setupPhase12Harness, type Harness } from "./helpers";

/**
 * Phase 12 public API surface for interactive sessions: create / get / stop
 * only. Input control, navigation and inspection stay session-cookie bound
 * by design; these tests pin that boundary plus scope and ownership rules.
 */

let harness: Harness;

beforeEach(() => {
  harness = setupPhase12Harness();
});

afterEach(() => {
  harness.teardown();
});

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "v1 Session Fixture",
  version: "2.0.0",
  background: { service_worker: "background.js" },
});

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", MANIFEST);
  zip.file("background.js", "chrome.runtime.onInstalled.addListener(() => {});");
  return zip.generateAsync({ type: "uint8array" });
}

function request(url: string, key: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(url, {
    method: init.method ?? "GET",
    body: init.body,
    headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });
}

interface OrgContext {
  orgId: string;
  ownerId: string;
  packageId: string;
  packageSha256: string;
  key: string;
}

async function orgWithPackage(): Promise<OrgContext> {
  const owner = makeUser();
  const org = createOrganization({ userId: owner.id }, { name: "v1 Sessions Co" });
  setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });
  const stored = await storeExtensionPackage({
    userId: owner.id,
    organizationId: org.id,
    bytes: await fixtureZip(),
    fileName: "v1.zip",
  });
    const key = createApiKey({ userId: owner.id, organizationId: org.id }, { name: "ci", scopes: ["browser-sessions:read", "browser-sessions:write"] }).key;
  return { orgId: org.id, ownerId: owner.id, packageId: stored.package.id, packageSha256: stored.package.sha256, key };
}

describe("v1 browser-sessions: create", () => {
  it("queues a session for an org package the key creator owns (202)", async () => {
    const context = await orgWithPackage();
    const response = (await postCreate(
      request("https://x/api/v1/browser-sessions", context.key, {
        method: "POST",
        body: JSON.stringify({ packageId: context.packageId }),
        headers: { "content-type": "application/json" },
      }),
    )) as NextResponse;
    expect(response.status).toBe(202);
    const body = (await response.json()) as { session: { id: string; status: string; packageName: string | null; packageSha256: string; extension: { name: string | null } } };
    expect(body.session.status).toBe("QUEUED");
    // Extension metadata is only known after a real browser load; a QUEUED
    // view must not invent it. The immutable package binding IS known.
    expect(body.session.extension.name).toBeNull();
    expect(body.session.packageSha256).toBe(context.packageSha256);

    const row = getSessionById(body.session.id)!;
    expect(row.organization_id).toBe(context.orgId);
    expect(row.user_id).toBe(context.ownerId);
    // A real start job was enqueued for the session.
    const job = getJobById(row.job_id!)!;
    expect(job.type).toBe("INTERACTIVE_BROWSER_START");

    // The org audit trail records the API-originated start.
    const audit = queryAuditEventsForOrg({ organizationId: context.orgId, limit: 10, offset: 0 });
    const started = audit.items.find((event) => event.action === "interactive_browser_started");
    expect(started?.metadata.via).toBe("api");
  });

  it("rejects keys without the browser-sessions:write scope", async () => {
    const context = await orgWithPackage();
    const readonlyKey = createApiKey({ userId: context.ownerId, organizationId: context.orgId }, { name: "ro", scopes: ["browser-sessions:read"] }).key;
    const response = (await postCreate(
      request("https://x/api/v1/browser-sessions", readonlyKey, {
        method: "POST",
        body: JSON.stringify({ packageId: context.packageId }),
        headers: { "content-type": "application/json" },
      }),
    )) as NextResponse;
    expect(response.status).toBe(403);
  });

  it("hides other organizations' packages (404, no existence leak)", async () => {
    const context = await orgWithPackage();
    const stranger = makeUser();
    const strangerOrg = createOrganization({ userId: stranger.id }, { name: "Elsewhere" });
    setOrganizationPlan({ organizationId: strangerOrg.id, planId: "pro", status: "active", seats: 5 });
    const strangerKey = createApiKey({ userId: stranger.id, organizationId: strangerOrg.id }, { name: "s", scopes: ["browser-sessions:read", "browser-sessions:write"] }).key;
    const response = (await postCreate(
      request("https://x/api/v1/browser-sessions", strangerKey, {
        method: "POST",
        body: JSON.stringify({ packageId: context.packageId }),
        headers: { "content-type": "application/json" },
      }),
    )) as NextResponse;
    expect(response.status).toBe(404);
  });
});

describe("v1 browser-sessions: status + stop", () => {
  it("returns a safe session view without runtime internals", async () => {
    const context = await orgWithPackage();
    const created = (await (postCreate(
      request("https://x/api/v1/browser-sessions", context.key, {
        method: "POST",
        body: JSON.stringify({ packageId: context.packageId }),
        headers: { "content-type": "application/json" },
      }),
    ) as Promise<NextResponse>)) as NextResponse;
    const { session } = (await created.json()) as { session: { id: string } };

    const status = (await getStatus(request(`https://x/api/v1/browser-sessions/${session.id}`, context.key), {
      params: Promise.resolve({ id: session.id }),
    })) as NextResponse;
    expect(status.status).toBe(200);
    const body = (await status.json()) as { session: Record<string, unknown> };
    expect(body.session.id).toBe(session.id);
    // Runtime internals (control ports, tokens) never appear in the view.
    expect(Object.keys(body.session).some((key) => /token|control/i.test(key))).toBe(false);

    // Another organization cannot even see the session.
    const stranger = makeUser();
    const strangerOrg = createOrganization({ userId: stranger.id }, { name: "NoPeek" });
    setOrganizationPlan({ organizationId: strangerOrg.id, planId: "pro", status: "active", seats: 5 });
    const strangerKey = createApiKey({ userId: stranger.id, organizationId: strangerOrg.id }, { name: "s", scopes: ["browser-sessions:read"] }).key;
    const denied = (await getStatus(request(`https://x/api/v1/browser-sessions/${session.id}`, strangerKey), {
      params: Promise.resolve({ id: session.id }),
    })) as NextResponse;
    expect(denied.status).toBe(404);
  });

  it("stops the session deterministically and audits via:api", async () => {
    const context = await orgWithPackage();
    const created = (await (postCreate(
      request("https://x/api/v1/browser-sessions", context.key, {
        method: "POST",
        body: JSON.stringify({ packageId: context.packageId }),
        headers: { "content-type": "application/json" },
      }),
    ) as Promise<NextResponse>)) as NextResponse;
    const { session } = (await created.json()) as { session: { id: string } };

    const stop = (await postStop(request(`https://x/api/v1/browser-sessions/${session.id}/stop`, context.key, { method: "POST" }), {
      params: Promise.resolve({ id: session.id }),
    })) as NextResponse;
    expect(stop.status).toBe(200);
    const stopped = (await stop.json()) as { session: { status: string } };
    expect(stopped.session.status).toBe("STOPPED");
    expect(getSessionById(session.id)!.stop_reason).toBe("stopped_by_user");

    const audit = queryAuditEventsForOrg({ organizationId: context.orgId, limit: 10, offset: 0 });
    expect(audit.items.some((event) => event.action === "interactive_browser_stopped" && event.metadata.via === "api")).toBe(true);
  });

  it("refuses to stop a session created by a different user (FORBIDDEN)", async () => {
    const context = await orgWithPackage();
    const created = (await (postCreate(
      request("https://x/api/v1/browser-sessions", context.key, {
        method: "POST",
        body: JSON.stringify({ packageId: context.packageId }),
        headers: { "content-type": "application/json" },
      }),
    ) as Promise<NextResponse>)) as NextResponse;
    const { session } = (await created.json()) as { session: { id: string } };

    // Same org, different member: can see it, cannot stop it.
    const member = makeUser("member@example.com");
    const { inviteMember, acceptInvitation } = await import("@/lib/organizations/service");
    const invitation = inviteMember({ userId: context.ownerId }, context.orgId, { email: "member@example.com", role: "admin" });
    acceptInvitation({ userId: member.id }, { token: invitation.token, email: "member@example.com" });
    const memberKey = createApiKey({ userId: member.id, organizationId: context.orgId }, { name: "m", scopes: ["browser-sessions:read", "browser-sessions:write"] }).key;

    const denied = (await postStop(request(`https://x/api/v1/browser-sessions/${session.id}/stop`, memberKey, { method: "POST" }), {
      params: Promise.resolve({ id: session.id }),
    })) as NextResponse;
    expect(denied.status).toBe(403);
    expect(getSessionById(session.id)!.status).toBe("QUEUED");
  });
});
