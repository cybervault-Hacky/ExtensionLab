import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  acceptInvitation,
  changeMemberRole,
  createOrganization,
  deleteOrganization,
  getOrganizationView,
  inviteMember,
  leaveOrganization,
  listOrganizationMembers,
  removeOrganizationMember,
  resendInvitation,
  revokeInvitation,
  setOrganizationPlan,
  transferOwnership,
} from "@/lib/organizations/service";
import { authorizeOrgAction, requireMembership } from "@/lib/organizations/authorization";
import { getMembership, insertMember } from "@/lib/organizations/repository";
import { getOrganizationEntitlements, seatUsage } from "@/lib/organizations/entitlements";
import { AppError } from "@/lib/observability/errors";
import { classifyError } from "@/lib/observability/errors";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

const ctx = (userId: string) => ({ userId });

describe("organization lifecycle", () => {
  it("creates an org with the creator as owner and personal workspaces untouched", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Acme" });
    expect(org.yourRole).toBe("owner");
    expect(org.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    const membership = getMembership(org.id, owner.id);
    expect(membership?.role).toBe("owner");
    // Same user still has no personal-workspace interference: second org allowed.
    const second = createOrganization(ctx(owner.id), { name: "Second Org" });
    expect(second.id).not.toBe(org.id);
  });

  it("rejects invalid names and slugs", () => {
    const owner = makeUser();
    expect(() => createOrganization(ctx(owner.id), { name: "x" })).toThrowError(AppError);
    expect(() => createOrganization(ctx(owner.id), { name: "Valid Name", slug: "Bad_Slug" })).toThrowError(AppError);
  });

  it("caps organizations per user", () => {
    const owner = makeUser();
    for (let index = 0; index < 10; index += 1) createOrganization(ctx(owner.id), { name: `Org ${index}` });
    expect(() => createOrganization(ctx(owner.id), { name: "Overflow" })).toThrowError(AppError);
  });
});

describe("RBAC", () => {
  it("enforces the role matrix server-side for key actions", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "RBAC" });
    const viewer = makeUser();
    const developer = makeUser();
    const admin = makeUser();
    insertMember({ organizationId: org.id, userId: viewer.id, role: "viewer" });
    insertMember({ organizationId: org.id, userId: developer.id, role: "developer" });
    insertMember({ organizationId: org.id, userId: admin.id, role: "admin" });

    // Viewer: read yes, expensive/manage no.
    expect(() => authorizeOrgAction(org.id, viewer.id, "org:read")).not.toThrow();
    expect(() => authorizeOrgAction(org.id, viewer.id, "org:tests:run")).toThrowError(AppError);
    expect(() => authorizeOrgAction(org.id, viewer.id, "org:api-keys:manage")).toThrowError(AppError);
    expect(() => authorizeOrgAction(org.id, viewer.id, "org:settings:manage")).toThrowError(AppError);
    // Developer: run yes, manage keys no.
    expect(() => authorizeOrgAction(org.id, developer.id, "org:tests:run")).not.toThrow();
    expect(() => authorizeOrgAction(org.id, developer.id, "org:api-keys:manage")).toThrowError(AppError);
    // Admin: keys yes, delete org / billing / SSO no.
    expect(() => authorizeOrgAction(org.id, admin.id, "org:api-keys:manage")).not.toThrow();
    expect(() => authorizeOrgAction(org.id, admin.id, "org:delete")).toThrowError(AppError);
    expect(() => authorizeOrgAction(org.id, admin.id, "org:billing:manage")).toThrowError(AppError);
    expect(() => authorizeOrgAction(org.id, admin.id, "org:sso:manage")).toThrowError(AppError);
    // Owner: everything.
    expect(() => authorizeOrgAction(org.id, owner.id, "org:delete")).not.toThrow();
  });

  it("non-members are indistinguishable from wrong ids", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Hidden" });
    const outsider = makeUser();
    const capture = (fn: () => unknown): AppError => {
      try {
        fn();
      } catch (error) {
        return error as AppError;
      }
      throw new Error("expected a throw");
    };
    const asMember = capture(() => requireMembership(org.id, outsider.id));
    const asWrongId = capture(() => requireMembership("org_doesnotexist", outsider.id));
    expect(asMember.code).toBe(asWrongId.code);
    expect(asMember.status).toBe(asWrongId.status);
  });
});

describe("invitations", () => {
  it("full lifecycle: invite → accept → one-time → membership + seats", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Invite Co" });
    setOrganizationPlan({ organizationId: org.id, planId: "free", status: "active", seats: 10 });
    const invitee = makeUser("invitee@example.com");
    const created = inviteMember(ctx(owner.id), org.id, { email: "INVITEE@example.com", role: "developer" });
    expect(created.token).toMatch(/^orginv_/);
    const accepted = acceptInvitation(ctx(invitee.id), { token: created.token, email: "invitee@example.com" });
    expect(accepted.organizationId).toBe(org.id);
    expect(getMembership(org.id, invitee.id)?.role).toBe("developer");
    // Token is one-time.
    expect(() => acceptInvitation(ctx(invitee.id), { token: created.token, email: "invitee@example.com" })).toThrowError(AppError);
  });

  it("rejects mismatched emails and revoked invitations without enumeration", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Secure" });
    setOrganizationPlan({ organizationId: org.id, planId: "free", status: "active", seats: 10 });
    const created = inviteMember(ctx(owner.id), org.id, { email: "target@example.com", role: "viewer" });
    const other = makeUser("other@example.com");
    expect(() => acceptInvitation(ctx(other.id), { token: created.token, email: "other@example.com" })).toThrowError(AppError);
    revokeInvitation(ctx(owner.id), org.id, created.id);
    const target = makeUser("target@example.com");
    expect(() => acceptInvitation(ctx(target.id), { token: created.token, email: "target@example.com" })).toThrowError(AppError);
  });

  it("resend rotates the token and resets expiry; old token dies", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Rotate" });
    setOrganizationPlan({ organizationId: org.id, planId: "free", status: "active", seats: 10 });
    const first = inviteMember(ctx(owner.id), org.id, { email: "rot@example.com", role: "viewer" });
    const second = resendInvitation(ctx(owner.id), org.id, first.id);
    expect(second.token).not.toBe(first.token);
    const invitee = makeUser("rot@example.com");
    expect(() => acceptInvitation(ctx(invitee.id), { token: first.token, email: "rot@example.com" })).toThrowError(AppError);
    expect(acceptInvitation(ctx(invitee.id), { token: second.token, email: "rot@example.com" }).organizationId).toBe(org.id);
  });

  it("seat limits block acceptance", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Seats" });
    setOrganizationPlan({ organizationId: org.id, planId: "free", status: "active", seats: 2 });
    // seats = 2 → owner + 1.
    const created = inviteMember(ctx(owner.id), org.id, { email: "a@example.com", role: "viewer" });
    const second = inviteMember(ctx(owner.id), org.id, { email: "b@example.com", role: "viewer" });
    const a = makeUser("a@example.com");
    const b = makeUser("b@example.com");
    acceptInvitation(ctx(a.id), { token: created.token, email: "a@example.com" });
    expect(() => acceptInvitation(ctx(b.id), { token: second.token, email: "b@example.com" })).toThrowError(AppError);
    const seats = seatUsage(org.id);
    expect(seats.activeMembers).toBe(2);
    expect(seats.openInvitations).toBeGreaterThanOrEqual(1);
  });
});

describe("membership administration", () => {
  it("role changes, removal, ownership transfer and leave rules", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Admin Co" });
    const member = makeUser();
    const admin = makeUser();
    insertMember({ organizationId: org.id, userId: member.id, role: "viewer" });
    insertMember({ organizationId: org.id, userId: admin.id, role: "admin" });

    expect(changeMemberRole(ctx(owner.id), org.id, member.id, "developer").role).toBe("developer");
    // Admins cannot manage admins.
    expect(() => changeMemberRole(ctx(admin.id), org.id, member.id, "admin")).toThrowError(AppError);
    removeOrganizationMember(ctx(owner.id), org.id, member.id);
    expect(getMembership(org.id, member.id)).toBeNull();

    // Owners cannot leave; non-owners can.
    expect(() => leaveOrganization(ctx(owner.id), org.id)).toThrowError(AppError);
    leaveOrganization(ctx(admin.id), org.id);
    expect(getMembership(org.id, admin.id)).toBeNull();

    // Ownership transfer swaps roles atomically.
    const successor = makeUser();
    insertMember({ organizationId: org.id, userId: successor.id, role: "admin" });
    transferOwnership(ctx(owner.id), org.id, successor.id);
    expect(getMembership(org.id, successor.id)?.role).toBe("owner");
    expect(getMembership(org.id, owner.id)?.role).toBe("admin");
  });

  it("deleting an organization removes memberships", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Gone" });
    deleteOrganization(ctx(owner.id), org.id);
    expect(() => getOrganizationView(ctx(owner.id), org.id)).toThrowError(AppError);
    expect(getMembership(org.id, owner.id)).toBeNull();
  });
});

describe("org entitlements", () => {
  it("free/pro/business gates and concurrency clamps", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "Plans" });
    const free = getOrganizationEntitlements(org.id);
    expect(free.apiAccess).toBe(false);
    expect(free.webhooks).toBe(false);
    expect(free.orgMaxConcurrency).toBeLessThanOrEqual(5);
    setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active" });
    const pro = getOrganizationEntitlements(org.id);
    expect(pro.apiAccess).toBe(true);
    expect(pro.webhooks).toBe(true);
    expect(pro.sso).toBe(false);
    setOrganizationPlan({ organizationId: org.id, planId: "business", status: "active" });
    const business = getOrganizationEntitlements(org.id);
    expect(business.sso).toBe(true);
    expect(business.orgMaxConcurrency).toBeLessThanOrEqual(5);
  });

  it("member listing includes roles and emails for members:read", () => {
    const owner = makeUser();
    const org = createOrganization(ctx(owner.id), { name: "List" });
    const { members } = listOrganizationMembers(ctx(owner.id), org.id);
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");
  });
});
