import type { NextRequest } from "next/server";
import { badRequest, requireApiUser } from "@/lib/auth/api";
import { getActiveWorkspace, mayActOnOrganization } from "@/lib/organizations/authorization";
import type { StudioViewer } from "@/lib/testing/studio-service";

/**
 * Resolves the studio viewer (user + active workspace) for dashboard routes.
 * Mutations inside an organization workspace additionally require the
 * org:tests:run role permission (§58) — reads only need membership.
 */
export async function studioViewerFor(request: NextRequest, mutation: boolean): Promise<StudioViewer> {
  const user = requireApiUser(request);
  const workspace = await getActiveWorkspace(user.id);
  if (workspace.organizationId && mutation && !mayActOnOrganization(user.id, workspace.organizationId, "org:tests:run")) {
    throw badRequest("Your workspace role does not allow editing tests.");
  }
  return { userId: user.id, organizationId: workspace.organizationId };
}
