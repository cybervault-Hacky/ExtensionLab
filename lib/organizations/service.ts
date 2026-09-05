import "server-only";
import { createHash } from "node:crypto";
import { getConfig } from "@/lib/config/env";
import { getDb, transaction } from "@/lib/db/client";
import { generateDbId } from "@/lib/db/ids";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { findUserByEmail, findUserById } from "@/lib/db/repositories/users";
import { recordAuditEvent } from "@/lib/audit/service";
import { dispatchOrganizationEvent } from "@/lib/webhooks/dispatch";
import {
  countMembers,
  countOrganizationsForUser,
  createInvitationRow,
  createOrganizationRow,
  deleteOrganizationRow,
  generateInvitationToken,
  getInvitationById,
  getInvitationByTokenHash,
  getMembership,
  getOrganizationById,
  hashInvitationToken,
  insertMember,
  listInvitations,
  listMembers,
  openInvitationForEmail,
  removeMember,
  slugify,
  updateInvitationRow,
  updateMemberRole,
  updateOrganizationRow,
} from "./repository";
import { entitlementsForOrgPlan, maxMembersFor } from "./entitlements";
import { isAssignableRole, isOrganizationRole, type OrganizationRole, type OrganizationView } from "./types";

/**
 * Organization service (Phase 10): creation, membership, invitations, roles.
 * All mutations emit audit events; security-sensitive failures are audited
 * too. Raw invitation tokens exist only in the response of the creating call.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 80;

export interface ServiceContext {
  userId: string;
  requestId?: string | null;
  ip?: string | null;
}

function toView(row: { id: string; name: string; slug: string; plan_id: string; plan_status: string; seats: number; created_at: number }, role: OrganizationRole): OrganizationView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    planId: row.plan_id,
    planStatus: row.plan_status,
    seats: row.seats,
    createdAt: row.created_at,
    yourRole: role,
  };
}

// ---------------------------------------------------------------------------

export function createOrganization(ctx: ServiceContext, input: { name: string; slug?: string | null }): OrganizationView {
  const name = input.name.trim();
  if (name.length < 2 || name.length > MAX_NAME_LENGTH) {
    throw new AppError("INVALID_INPUT", { message: "Organization names must be 2–80 characters." });
  }
  if (input.slug !== undefined && input.slug !== null && !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(input.slug)) {
    throw new AppError("INVALID_INPUT", { message: "Slugs must be 3–40 lowercase letters, digits or dashes." });
  }
  const config = getConfig();
  if (countOrganizationsForUser(ctx.userId) >= config.organizations.maxPerUser) {
    throw new AppError("CONFLICT", { message: "You have reached the maximum number of organizations for your account." });
  }
  const { row, member } = createOrganizationRow({ name, ownerUserId: ctx.userId, planId: config.organizations.defaultPlan, slugHint: input.slug });
  recordAuditEvent({
    organizationId: row.id,
    actorUserId: ctx.userId,
    action: "org.created",
    resourceType: "organization",
    resourceId: row.id,
    requestId: ctx.requestId,
    ip: ctx.ip,
    metadata: { name: row.name, slug: row.slug, plan: row.plan_id },
  });
  recordMetric("organization.created", 1);
  logger.info("organization.created", { organizationId: row.id, userId: ctx.userId });
  return toView(row, member.role);
}

export function getOrganizationView(ctx: ServiceContext, organizationId: string): OrganizationView {
  const membership = getMembership(organizationId, ctx.userId);
  if (!membership) throw new AppError("ORGANIZATION_NOT_FOUND");
  const row = getOrganizationById(organizationId);
  if (!row) throw new AppError("ORGANIZATION_NOT_FOUND");
  return toView(row, membership.role);
}

export function updateOrganizationProfile(ctx: ServiceContext, organizationId: string, input: { name?: string }): OrganizationView {
  const membership = getMembership(organizationId, ctx.userId);
  if (!membership) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (membership.role !== "owner" && membership.role !== "admin") throw new AppError("ROLE_REQUIRED");
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > MAX_NAME_LENGTH) {
      throw new AppError("INVALID_INPUT", { message: "Organization names must be 2–80 characters." });
    }
    updateOrganizationRow(organizationId, { name });
  }
  const row = getOrganizationById(organizationId)!;
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "org.updated", resourceType: "organization", resourceId: organizationId, requestId: ctx.requestId, ip: ctx.ip, metadata: { name: row.name } });
  return toView(row, membership.role);
}

/** Owner-only, irreversible. Cascades to every organization-owned row. */
export function deleteOrganization(ctx: ServiceContext, organizationId: string): void {
  const membership = getMembership(organizationId, ctx.userId);
  if (!membership) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (membership.role !== "owner") throw new AppError("ROLE_REQUIRED");
  const row = getOrganizationById(organizationId);
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "org.deleted", resourceType: "organization", resourceId: organizationId, requestId: ctx.requestId, ip: ctx.ip, metadata: { name: row?.name ?? "" } });
  deleteOrganizationRow(organizationId);
  recordMetric("organization.deleted", 1);
  logger.info("organization.deleted", { organizationId, userId: ctx.userId });
}

export function leaveOrganization(ctx: ServiceContext, organizationId: string): void {
  const membership = getMembership(organizationId, ctx.userId);
  if (!membership) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (membership.role === "owner") {
    throw new AppError("CONFLICT", { message: "Owners must transfer ownership or delete the organization before leaving." });
  }
  removeMember(organizationId, ctx.userId);
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "member.left", resourceType: "organization", resourceId: organizationId, requestId: ctx.requestId, ip: ctx.ip });
}

// Members ---------------------------------------------------------------------

export interface MemberView {
  userId: string;
  email: string;
  name: string | null;
  role: OrganizationRole;
  isOwner: boolean;
  joinedAt: number;
}

export function listOrganizationMembers(ctx: ServiceContext, organizationId: string): { members: MemberView[]; seats: { seats: number; activeMembers: number; maxMembers: number } } {
  const membership = getMembership(organizationId, ctx.userId);
  if (!membership) throw new AppError("ORGANIZATION_NOT_FOUND");
  const members = listMembers(organizationId).map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    isOwner: row.role === "owner",
    joinedAt: row.created_at,
  }));
  const org = getOrganizationById(organizationId)!;
  return { members, seats: { seats: org.seats, activeMembers: members.length, maxMembers: maxMembersFor(organizationId) } };
}

export function changeMemberRole(ctx: ServiceContext, organizationId: string, targetUserId: string, role: string): MemberView {
  const actor = getMembership(organizationId, ctx.userId);
  if (!actor) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("ROLE_REQUIRED");
  if (!isAssignableRole(role)) throw new AppError("INVALID_INPUT", { message: "Role must be admin, developer or viewer." });
  const target = getMembership(organizationId, targetUserId);
  if (!target) throw new AppError("NOT_FOUND", { message: "Member not found." });
  if (target.role === "owner") throw new AppError("CONFLICT", { message: "The owner's role can only change through ownership transfer." });
  // Admins cannot promote to admin or manage other admins — owner only.
  if (actor.role === "admin" && (role === "admin" || target.role === "admin")) {
    throw new AppError("ROLE_REQUIRED");
  }
  if (!updateMemberRole(organizationId, targetUserId, role)) throw new AppError("NOT_FOUND", { message: "Member not found." });
  recordAuditEvent({
    organizationId,
    actorUserId: ctx.userId,
    action: "member.role_changed",
    resourceType: "member",
    resourceId: targetUserId,
    requestId: ctx.requestId,
    ip: ctx.ip,
    success: true,
    metadata: { from: target.role, to: role },
  });
  const refreshed = getMembership(organizationId, targetUserId)!;
  const user = findUserById(targetUserId);
  return { userId: targetUserId, email: user?.email ?? "", name: user?.name ?? null, role: refreshed.role, isOwner: refreshed.role === "owner", joinedAt: refreshed.created_at };
}

export function removeOrganizationMember(ctx: ServiceContext, organizationId: string, targetUserId: string): void {
  const actor = getMembership(organizationId, ctx.userId);
  if (!actor) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("ROLE_REQUIRED");
  const target = getMembership(organizationId, targetUserId);
  if (!target) throw new AppError("NOT_FOUND", { message: "Member not found." });
  if (target.role === "owner") throw new AppError("CONFLICT", { message: "The owner cannot be removed. Transfer ownership first." });
  if (actor.role === "admin" && target.role === "admin") throw new AppError("ROLE_REQUIRED");
  removeMember(organizationId, targetUserId);
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "member.removed", resourceType: "member", resourceId: targetUserId, requestId: ctx.requestId, ip: ctx.ip });
}

/** Owner transfers ownership and demotes themselves to admin. */
export function transferOwnership(ctx: ServiceContext, organizationId: string, targetUserId: string): void {
  const actor = getMembership(organizationId, ctx.userId);
  if (!actor) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (actor.role !== "owner") throw new AppError("ROLE_REQUIRED");
  const target = getMembership(organizationId, targetUserId);
  if (!target) throw new AppError("NOT_FOUND", { message: "Member not found." });
  if (targetUserId === ctx.userId) throw new AppError("INVALID_INPUT", { message: "Ownership cannot be transferred to yourself." });
  const db = getDb();
  transaction(db, () => {
    updateMemberRole(organizationId, ctx.userId, "admin");
    updateMemberRole(organizationId, targetUserId, "owner");
    db.prepare("UPDATE organizations SET owner_user_id = ?, updated_at = ? WHERE id = ?").run(targetUserId, Date.now(), organizationId);
  });
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "org.ownership_transferred", resourceType: "member", resourceId: targetUserId, requestId: ctx.requestId, ip: ctx.ip });
}

// Invitations -----------------------------------------------------------------

export interface InvitationView {
  id: string;
  email: string;
  role: Exclude<OrganizationRole, "owner">;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  resendCount: number;
  createdAt: number;
}

export interface CreatedInvitation extends InvitationView {
  /** Shown exactly once; only the SHA-256 hash is persisted. */
  token: string;
}

function toInvitationView(row: { id: string; email: string; role: string; expires_at: number; accepted_at: number | null; revoked_at: number | null; resend_count: number; created_at: number }): InvitationView {
  return { id: row.id, email: row.email, role: row.role as Exclude<OrganizationRole, "owner">, expiresAt: row.expires_at, acceptedAt: row.accepted_at, revokedAt: row.revoked_at, resendCount: row.resend_count, createdAt: row.created_at };
}

export function inviteMember(ctx: ServiceContext, organizationId: string, input: { email: string; role: string }): CreatedInvitation {
  const actor = getMembership(organizationId, ctx.userId);
  if (!actor) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("ROLE_REQUIRED");
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 200) throw new AppError("INVALID_INPUT", { message: "A valid email address is required." });
  if (!isAssignableRole(input.role)) throw new AppError("INVALID_INPUT", { message: "Role must be admin, developer or viewer." });
  // Admins can only invite developers/viewers.
  if (actor.role === "admin" && input.role === "admin") throw new AppError("ROLE_REQUIRED");

  const existingUser = findUserByEmail(email);
  if (existingUser && getMembership(organizationId, existingUser.id)) {
    throw new AppError("CONFLICT", { message: "This person is already a member of the organization." });
  }
  if (openInvitationForEmail(organizationId, email)) {
    throw new AppError("CONFLICT", { message: "An open invitation for this email already exists." });
  }
  const members = countMembers(organizationId);
  const maxMembers = maxMembersFor(organizationId);
  const org = getOrganizationById(organizationId)!;
  if (members >= Math.min(maxMembers, org.seats)) {
    throw new AppError("SEAT_LIMIT_REACHED", { message: `All ${org.seats} seat(s) are in use. Add seats in Billing first.` });
  }

  const token = generateInvitationToken();
  const row = createInvitationRow({
    organizationId,
    email,
    role: input.role,
    tokenHash: hashInvitationToken(token),
    invitedBy: ctx.userId,
    expiresAt: Date.now() + getConfig().organizations.invitationTtlMs,
  });
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "member.invited", resourceType: "invitation", resourceId: row.id, requestId: ctx.requestId, ip: ctx.ip, metadata: { email, role: input.role } });
  return { ...toInvitationView(row), token };
}

export function resendInvitation(ctx: ServiceContext, organizationId: string, invitationId: string): CreatedInvitation {
  const actor = getMembership(organizationId, ctx.userId);
  if (!actor) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("ROLE_REQUIRED");
  const row = getInvitationById(invitationId);
  if (!row || row.organization_id !== organizationId) throw new AppError("NOT_FOUND", { message: "Invitation not found." });
  if (row.accepted_at || row.revoked_at) throw new AppError("CONFLICT", { message: "This invitation is no longer open." });
  if (row.resend_count >= 10) throw new AppError("CONFLICT", { message: "This invitation has been resent too many times. Create a new one." });
  const token = generateInvitationToken();
  updateInvitationRow(row.id, { token_hash: hashInvitationToken(token), expires_at: Date.now() + getConfig().organizations.invitationTtlMs, resend_count: row.resend_count + 1 });
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "member.invitation_resent", resourceType: "invitation", resourceId: row.id, requestId: ctx.requestId, ip: ctx.ip });
  return { ...toInvitationView(getInvitationById(row.id)!), token };
}

export function revokeInvitation(ctx: ServiceContext, organizationId: string, invitationId: string): void {
  const actor = getMembership(organizationId, ctx.userId);
  if (!actor) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("ROLE_REQUIRED");
  const row = getInvitationById(invitationId);
  if (!row || row.organization_id !== organizationId) throw new AppError("NOT_FOUND", { message: "Invitation not found." });
  if (row.accepted_at || row.revoked_at) return;
  updateInvitationRow(row.id, { revoked_at: Date.now() });
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "member.invitation_revoked", resourceType: "invitation", resourceId: row.id, requestId: ctx.requestId, ip: ctx.ip });
}

export function listOrganizationInvitations(ctx: ServiceContext, organizationId: string): InvitationView[] {
  const actor = getMembership(organizationId, ctx.userId);
  if (!actor) throw new AppError("ORGANIZATION_NOT_FOUND");
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("ROLE_REQUIRED");
  return listInvitations(organizationId).map(toInvitationView);
}

/**
 * Accepts an invitation. The token alone is not enough: the accepting account's
 * email must match the invited email, the invitation must be open and
 * unexpired, and the organization must still have a free seat. Failure is
 * audited without ever revealing whether an invitation exists.
 */
export function acceptInvitation(ctx: ServiceContext, input: { token: string; email: string }): { organizationId: string; organizationName: string; slug: string } {
  const token = input.token.trim();
  const email = input.email.trim().toLowerCase();
  const row = getInvitationByTokenHash(hashInvitationToken(token));
  if (!row) {
    recordAuditEvent({ organizationId: "unknown", actorUserId: ctx.userId, action: "member.invitation_accepted", success: false, requestId: ctx.requestId, ip: ctx.ip, metadata: { reason: "not_found" } });
    throw new AppError("INVITATION_INVALID");
  }
  const organizationId = row.organization_id;
  const fail = (action: "INVITATION_EXPIRED" | "INVITATION_REVOKED" | "INVITATION_INVALID" | "CONFLICT" | "SEAT_LIMIT_REACHED", reason: string): never => {
    recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "member.invitation_accepted", success: false, requestId: ctx.requestId, ip: ctx.ip, metadata: { reason } });
    throw new AppError(action);
  };
  if (row.revoked_at) fail("INVITATION_REVOKED", "revoked");
  if (row.accepted_at) fail("INVITATION_INVALID", "already_used");
  if (Date.now() > row.expires_at) fail("INVITATION_EXPIRED", "expired");
  if (row.email !== email) fail("INVITATION_INVALID", "email_mismatch");
  const org = getOrganizationById(organizationId);
  if (!org) fail("INVITATION_INVALID", "org_missing");
  const seats = org?.seats ?? 0;
  if (getMembership(organizationId, ctx.userId)) fail("CONFLICT", "already_member");
  if (countMembers(organizationId) >= Math.min(maxMembersFor(organizationId), seats)) fail("SEAT_LIMIT_REACHED", "seats");

  transaction(getDb(), () => {
    updateInvitationRow(row.id, { accepted_at: Date.now(), accepted_by: ctx.userId });
    insertMember({ organizationId, userId: ctx.userId, role: row.role });
  });
  recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "member.invitation_accepted", resourceType: "invitation", resourceId: row.id, requestId: ctx.requestId, ip: ctx.ip, metadata: { role: row.role } });
  dispatchOrganizationEvent(organizationId, "member.joined", { organizationId, userId: ctx.userId, role: row.role });
  return { organizationId, organizationName: org?.name ?? "", slug: org?.slug ?? "" };
}

// Billing hooks -----------------------------------------------------------------

/** Server-authoritative org plan change (billing webhook path or operator action). */
export function setOrganizationPlan(input: { organizationId: string; planId: "free" | "pro" | "business"; status: "none" | "active" | "canceled"; provider?: string | null; providerSubscriptionId?: string | null; seats?: number; actorUserId?: string | null }): void {
  const org = getOrganizationById(input.organizationId);
  if (!org) throw new AppError("ORGANIZATION_NOT_FOUND");
  const entitlements = entitlementsForOrgPlan(input.planId);
  const seats = Math.max(1, Math.min(input.seats ?? org.seats, entitlements.maxMembers));
  updateOrganizationRow(input.organizationId, {
    plan_id: input.planId,
    plan_status: input.status,
    provider: input.provider !== undefined ? input.provider : org.provider,
    provider_subscription_id: input.providerSubscriptionId !== undefined ? input.providerSubscriptionId : org.provider_subscription_id,
    seats,
  });
  recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? null,
    action: "org.plan_changed",
    resourceType: "organization",
    resourceId: input.organizationId,
    metadata: { plan: input.planId, status: input.status, seats: String(seats) },
  });
  recordMetric("organization.plan_changed", 1, { plan: input.planId });
}

export { slugify, generateDbId, isOrganizationRole };
