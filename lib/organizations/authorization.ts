import "server-only";
import { cookies } from "next/headers";
import { AppError } from "@/lib/observability/errors";
import { getMembership, getOrganizationById, listOrganizationsForUser } from "./repository";
import { roleHasPermission, type OrgAction, type OrganizationRole } from "./types";

/**
 * Server-side organization authorization (Phase 10).
 *
 * Every protected operation calls `authorizeOrgAction` (or the underlying
 * `requireMembership`) before touching data. A client-supplied organization id
 * is never trusted: it is always validated against the caller's membership and
 * role. The dashboard "selected workspace" is a hint, not an authorization
 * decision.
 */

export const WORKSPACE_COOKIE = "extensionlab_workspace";

export interface OrgMembershipContext {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}

export function getMembershipContext(organizationId: string, userId: string): OrgMembershipContext | null {
  const membership = getMembership(organizationId, userId);
  if (!membership) return null;
  return { organizationId, userId, role: membership.role };
}

/** Throws ORGANIZATION_NOT_FOUND for non-members (indistinguishable from a wrong id). */
export function requireMembership(organizationId: string, userId: string): OrgMembershipContext {
  const context = getMembershipContext(organizationId, userId);
  if (!context) {
    throw new AppError("ORGANIZATION_NOT_FOUND", { message: "Organization not found." });
  }
  return context;
}

/** Centralized role check used by every protected organization operation. */
export function authorizeOrgAction(organizationId: string, userId: string, action: OrgAction): OrgMembershipContext {
  const context = requireMembership(organizationId, userId);
  if (!roleHasPermission(context.role, action)) {
    throw new AppError("ROLE_REQUIRED");
  }
  return context;
}

/** Authorization for API-key requests: the key's organization membership is implied. */
export function authorizeApiKeyAction(roleFromKeyCreator: OrganizationRole, action: OrgAction): void {
  if (!roleHasPermission(roleFromKeyCreator, action)) {
    throw new AppError("API_SCOPE_DENIED", { message: "The API key's role does not permit this action." });
  }
}

export interface WorkspaceOption {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
}

export interface ActiveWorkspace {
  kind: "personal" | "organization";
  organizationId: string | null;
  organization: WorkspaceOption | null;
  options: WorkspaceOption[];
}

/**
 * Resolves the caller's currently selected workspace from the workspace
 * cookie. The cookie value is only a hint: it is validated against actual
 * memberships, and an invalid/stale value silently falls back to the personal
 * workspace.
 */
export async function getActiveWorkspace(userId: string): Promise<ActiveWorkspace> {
  const rows = listOrganizationsForUser(userId);
  const options: WorkspaceOption[] = rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, role: row.role }));
  const store = await cookies();
  const requested = store.get(WORKSPACE_COOKIE)?.value ?? "";
  if (requested && requested !== "personal") {
    const match = options.find((option) => option.id === requested);
    if (match) {
      return { kind: "organization", organizationId: match.id, organization: match, options };
    }
  }
  return { kind: "personal", organizationId: null, organization: null, options };
}

/** Non-throwing variant for read paths that must degrade gracefully. */
export function mayActOnOrganization(userId: string, organizationId: string, action: OrgAction): boolean {
  const membership = getMembership(organizationId, userId);
  if (!membership) return false;
  return roleHasPermission(membership.role, action);
}

/** Resolves an organization a caller may act on, or null (never leaks existence). */
export function resolveAuthorizedOrganization(userId: string, organizationId: string): { id: string; role: OrganizationRole } | null {
  const membership = getMembership(organizationId, userId);
  if (!membership) return null;
  const org = getOrganizationById(organizationId);
  if (!org) return null;
  return { id: org.id, role: membership.role };
}
