import "server-only";
import { getConfig } from "@/lib/config/env";
import { getOrganizationById, countMembers, listInvitations } from "./repository";
import type { PlanId } from "@/lib/billing/types";

/**
 * Organization entitlement service (Phase 10).
 *
 * Mirrors the Phase 7 user entitlement service pattern: every decision flows
 * through here — there is no scattered plan checking. Values are
 * server-authoritative (organizations.plan_id is only written by the billing
 * flow or an operator migration, never accepted from clients).
 *
 * Seat/plan changes through billing providers are limited to what the
 * configured provider supports; the internal abstraction is complete and the
 * provider limitation is documented in docs/ENTERPRISE.md.
 */

export interface OrganizationEntitlements {
  organizationWorkspace: boolean;
  maxMembers: number;
  apiAccess: boolean;
  webhooks: boolean;
  advancedAuditLogs: boolean;
  sso: boolean;
  dataExport: boolean;
  highConcurrency: boolean;
  orgMaxConcurrency: number;
  advancedBrowserMatrix: boolean;
  ciCd: boolean;
  customLimits: boolean;
  extendedArtifactRetentionDays: number | null;
}

const FREE: OrganizationEntitlements = {
  organizationWorkspace: true,
  maxMembers: 2,
  apiAccess: false,
  webhooks: false,
  advancedAuditLogs: false,
  sso: false,
  dataExport: false,
  highConcurrency: false,
  orgMaxConcurrency: 2,
  advancedBrowserMatrix: false,
  ciCd: false,
  customLimits: false,
  extendedArtifactRetentionDays: null,
};

const PRO: OrganizationEntitlements = {
  ...FREE,
  maxMembers: 10,
  apiAccess: true,
  webhooks: true,
  advancedAuditLogs: true,
  dataExport: true,
  orgMaxConcurrency: 4,
  advancedBrowserMatrix: true,
  ciCd: true,
};

const BUSINESS: OrganizationEntitlements = {
  ...PRO,
  maxMembers: 50,
  sso: true,
  highConcurrency: true,
  orgMaxConcurrency: 8,
  extendedArtifactRetentionDays: 180,
};

const BY_PLAN: Record<PlanId, OrganizationEntitlements> = { free: FREE, pro: PRO, business: BUSINESS };

function numEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw !== undefined && raw !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
    }
  }
  return fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true";
}

/** Entitlements for an organization plan, with operator overrides honored. */
export function entitlementsForOrgPlan(planId: PlanId): OrganizationEntitlements {
  const base = BY_PLAN[planId] ?? FREE;
  const P = `ORG_PLAN_${planId.toUpperCase()}_`;
  return {
    ...base,
    maxMembers: numEnv([`${P}MAX_MEMBERS`], base.maxMembers),
    apiAccess: boolEnv(`${P}API_ACCESS`, base.apiAccess),
    webhooks: boolEnv(`${P}WEBHOOKS`, base.webhooks),
    advancedAuditLogs: boolEnv(`${P}ADVANCED_AUDIT`, base.advancedAuditLogs),
    sso: boolEnv(`${P}SSO`, base.sso),
    dataExport: boolEnv(`${P}DATA_EXPORT`, base.dataExport),
    orgMaxConcurrency: numEnv([`${P}MAX_CONCURRENCY`], base.orgMaxConcurrency),
  };
}

export function getOrganizationEntitlements(organizationId: string): OrganizationEntitlements {
  const org = getOrganizationById(organizationId);
  if (!org) return entitlementsForOrgPlan("free");
  const planId = (["free", "pro", "business"] as const).includes(org.plan_id as PlanId) ? (org.plan_id as PlanId) : "free";
  const entitlements = entitlementsForOrgPlan(planId);
  // The deployment-wide org concurrency ceiling always applies on top.
  const ceiling = getConfig().jobs10.orgMaxConcurrency;
  return { ...entitlements, orgMaxConcurrency: Math.min(entitlements.orgMaxConcurrency, ceiling) };
}

export interface OrgEntitlementVerdict {
  allowed: boolean;
  reason: "plan" | "seats" | null;
  message?: string;
  entitlements: OrganizationEntitlements;
}

function deny(reason: OrgEntitlementVerdict["reason"], message: string, entitlements: OrganizationEntitlements): OrgEntitlementVerdict {
  return { allowed: false, reason, message, entitlements };
}

export function canUseOrgFeature(organizationId: string, feature: "apiAccess" | "webhooks" | "advancedAuditLogs" | "sso" | "dataExport" | "highConcurrency" | "advancedBrowserMatrix" | "ciCd"): OrgEntitlementVerdict {
  const entitlements = getOrganizationEntitlements(organizationId);
  if (entitlements[feature]) return { allowed: true, reason: null, entitlements };
  return deny("plan", `This feature is not included in your organization's plan.`, entitlements);
}

export function maxMembersFor(organizationId: string): number {
  return getOrganizationEntitlements(organizationId).maxMembers;
}

export function orgConcurrencyFor(organizationId: string): number {
  return getOrganizationEntitlements(organizationId).orgMaxConcurrency;
}

/** Seats: billed seats must cover active members + open invitations. */
export function seatUsage(organizationId: string): { seats: number; activeMembers: number; openInvitations: number; available: number } {
  const org = getOrganizationById(organizationId);
  const seats = org?.seats ?? 1;
  const activeMembers = org ? countMembers(organizationId) : 0;
  const openInvitations = org
    ? listInvitations(organizationId).filter((invitation) => invitation.accepted_at === null && invitation.revoked_at === null).length
    : 0;
  return { seats, activeMembers, openInvitations, available: Math.max(0, seats - activeMembers - openInvitations) };
}
