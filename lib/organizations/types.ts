import "server-only";

/**
 * Phase 10 organization model: roles, permissions and safe projections.
 *
 * Authorization is enforced server-side by `authorizeOrgAction` before any
 * protected operation; the UI only mirrors what the server already enforces.
 */

export type OrganizationRole = "owner" | "admin" | "developer" | "viewer";

export const ORGANIZATION_ROLES: readonly OrganizationRole[] = ["owner", "admin", "developer", "viewer"];
export const ASSIGNABLE_ROLES: readonly Exclude<OrganizationRole, "owner">[] = ["admin", "developer", "viewer"];

/** Every protected organization action. Checks go through the permission map. */
export type OrgAction =
  | "org:read"
  | "org:update"
  | "org:delete"
  | "org:billing:manage"
  | "org:members:read"
  | "org:members:manage"
  | "org:role:change"
  | "org:ownership:transfer"
  | "org:invitations:manage"
  | "org:api-keys:manage"
  | "org:webhooks:manage"
  | "org:audit:read"
  | "org:audit:export"
  | "org:exports:manage"
  | "org:settings:manage"
  | "org:sso:manage"
  | "org:domains:manage"
  | "org:policy:manage"
  | "org:publications:manage"
  | "org:projects:create"
  | "org:projects:delete"
  | "org:packages:upload"
  | "org:packages:delete"
  | "org:analysis:run"
  | "org:tests:run"
  | "org:matrices:run"
  | "org:regressions:run"
  | "org:reports:create"
  | "org:reports:share"
  | "org:resources:read";

const VIEWER: readonly OrgAction[] = ["org:read", "org:members:read", "org:resources:read"];

const DEVELOPER: readonly OrgAction[] = [
  ...VIEWER,
  "org:projects:create",
  "org:packages:upload",
  "org:analysis:run",
  "org:tests:run",
  "org:matrices:run",
  "org:regressions:run",
  "org:reports:create",
];

const ADMIN: readonly OrgAction[] = [
  ...DEVELOPER,
  "org:members:manage",
  "org:invitations:manage",
  "org:update",
  "org:projects:delete",
  "org:packages:delete",
  "org:api-keys:manage",
  "org:webhooks:manage",
  "org:audit:read",
  "org:audit:export",
  "org:exports:manage",
  "org:settings:manage",
  "org:domains:manage",
  "org:policy:manage",
  "org:publications:manage",
  "org:reports:share",
  "org:role:change",
];

const OWNER: readonly OrgAction[] = [
  ...ADMIN,
  "org:delete",
  "org:billing:manage",
  "org:ownership:transfer",
  "org:sso:manage",
];

export const ROLE_PERMISSIONS: Record<OrganizationRole, readonly OrgAction[]> = {
  owner: OWNER,
  admin: ADMIN,
  developer: DEVELOPER,
  viewer: VIEWER,
};

export function roleHasPermission(role: OrganizationRole, action: OrgAction): boolean {
  return ROLE_PERMISSIONS[role].includes(action);
}

const ROLE_RANK: Record<OrganizationRole, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: OrganizationRole, minimum: OrganizationRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === "string" && (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

export function isAssignableRole(value: unknown): value is Exclude<OrganizationRole, "owner"> {
  return typeof value === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/** Public (member-facing) projection of an organization. Never includes secrets. */
export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  planId: string;
  planStatus: string;
  seats: number;
  createdAt: number;
  yourRole: OrganizationRole;
}

/** Audit-log visibility requires admin or owner. */
export function canViewAudit(role: OrganizationRole): boolean {
  return roleHasPermission(role, "org:audit:read");
}
