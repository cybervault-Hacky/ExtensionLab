import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { requestExport, runOrganizationExport, listExports, getExportDownload, expireExports } from "@/lib/organizations/export";
import { createOrganization, setOrganizationPlan, inviteMember, acceptInvitation } from "@/lib/organizations/service";
import { insertMember } from "@/lib/organizations/repository";
import { getStorage } from "@/lib/storage/storage";
import { getDb } from "@/lib/db/client";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

function proOrg(name = "Export Co"): { orgId: string; owner: string } {
  const owner = makeUser();
  const org = createOrganization({ userId: owner.id }, { name });
  setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 10 });
  return { orgId: org.id, owner: owner.id };
}

describe("organization data export", () => {
  it("request → run → download, with audit trail and org-scoped access", async () => {
    const { orgId, owner } = proOrg();
    const view = await requestExport({ userId: owner, organizationId: orgId });
    expect(view.status).toBe("queued");
    // Only one active export per organization at a time.
    await expect(requestExport({ userId: owner, organizationId: orgId })).rejects.toThrow();

    const result = await runOrganizationExport(view.id, orgId);
    expect(result.status).toBe("completed");

    const download = getExportDownload({ userId: owner, organizationId: orgId }, view.id);
    expect(download.storageKey).toContain(orgId);
    const bytes = await getStorage().get(download.storageKey);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { organization: { id: string }; packages?: unknown[] };
    expect(parsed.organization.id).toBe(orgId);
    // Metadata-only export: no source bytes.
    expect(JSON.stringify(parsed)).not.toMatch(/"content"/);

    // Export is audited.
    const audited = getDb()
      .prepare("SELECT COUNT(*) AS n FROM organization_audit_events WHERE organization_id = ? AND action IN ('export.requested','export.downloaded')")
      .get(orgId) as { n: number };
    expect(audited.n).toBeGreaterThanOrEqual(2);
  });

  it("non-admins cannot request or download; other orgs see nothing", async () => {
    const { orgId, owner } = proOrg();
    const other = proOrg("Other Co");
    const developer = makeUser();
    insertMember({ organizationId: orgId, userId: developer.id, role: "developer" });
    await expect(requestExport({ userId: developer.id, organizationId: orgId })).rejects.toThrow();

    const view = await requestExport({ userId: owner, organizationId: orgId });
    await runOrganizationExport(view.id, orgId);
    expect(() => getExportDownload({ userId: developer.id, organizationId: orgId }, view.id)).toThrow();
    expect(() => getExportDownload({ userId: other.owner, organizationId: other.orgId }, view.id)).toThrow();
  });

  it("expired exports are removed from storage and marked expired", async () => {
    const { orgId, owner } = proOrg();
    const view = await requestExport({ userId: owner, organizationId: orgId });
    await runOrganizationExport(view.id, orgId);
    getDb().prepare("UPDATE organization_exports SET expires_at = 1 WHERE id = ?").run(view.id);
    const removed = await expireExports();
    expect(removed).toBeGreaterThanOrEqual(1);
    const rows = getDb().prepare("SELECT status FROM organization_exports WHERE id = ?").get(view.id) as { status: string };
    expect(rows.status).toBe("expired");
    expect(() => getExportDownload({ userId: owner, organizationId: orgId }, view.id)).toThrow();
  });

  it("listing is org-scoped and excludes other organizations' exports", async () => {
    const a = proOrg("List A");
    const b = proOrg("List B");
    await requestExport({ userId: a.owner, organizationId: a.orgId });
    const forB = listExports({ userId: b.owner, organizationId: b.orgId });
    expect(forB).toHaveLength(0);
    const forA = listExports({ userId: a.owner, organizationId: a.orgId });
    expect(forA).toHaveLength(1);
  });

  it("invited-but-unaccepted members do not consume export access", async () => {
    const { orgId, owner } = proOrg();
    const created = inviteMember({ userId: owner }, orgId, { email: "export-never@example.com", role: "admin" });
    const invitee = makeUser("export-never@example.com");
    // Not accepted → no membership → no export rights even with the token.
    expect(() => acceptInvitation({ userId: invitee.id }, { token: "x".repeat(40), email: "export-never@example.com" })).toThrow();
    await expect(requestExport({ userId: invitee.id, organizationId: orgId })).rejects.toThrow();
    void created;
  });
});
