import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";
import { getActiveWorkspace, requireMembership } from "@/lib/organizations/authorization";
import { roleHasPermission, type OrgAction } from "@/lib/organizations/types";
import type { OrganizationRole } from "@/lib/organizations/types";

/**
 * Server-side guard for /dashboard/organization/* pages. Authorization happens
 * here (never via UI hiding): a non-member or a member without the required
 * action is redirected to their dashboard. Data endpoints enforce the same
 * rules independently.
 */
export async function requireOrgPage(minimumAction: OrgAction): Promise<{
  userId: string;
  organizationId: string;
  role: OrganizationRole;
}> {
  const store = await cookies();
  const user = restoreUser(store.get(SESSION_COOKIE)?.value ?? "");
  if (!user) redirect("/login?next=%2Fdashboard");
  const workspace = await getActiveWorkspace(user.id);
  if (workspace.kind !== "organization" || !workspace.organizationId) redirect("/dashboard?workspace=organization-required");
  const membership = requireMembership(workspace.organizationId, user.id);
  if (!roleHasPermission(membership.role, minimumAction)) redirect("/dashboard/organization?forbidden=1");
  return { userId: user.id, organizationId: workspace.organizationId, role: membership.role };
}
