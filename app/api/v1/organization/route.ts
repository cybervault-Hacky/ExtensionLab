import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getOrganizationById, countMembers } from "@/lib/organizations/repository";
import { getOrganizationEntitlements, seatUsage } from "@/lib/organizations/entitlements";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/organization — the API key's organization (plan, seats, usage). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "organization:read", rateClass: "read" }, async (context) => {
    const org = getOrganizationById(context.principal.organizationId);
    if (!org) throw new AppError("NOT_FOUND");
    const entitlements = getOrganizationEntitlements(org.id);
    const seats = seatUsage(org.id);
    return NextResponse.json({
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        planId: org.plan_id,
        planStatus: org.plan_status,
        createdAt: org.created_at,
        members: countMembers(org.id),
        seats,
        entitlements: {
          apiAccess: entitlements.apiAccess,
          webhooks: entitlements.webhooks,
          advancedAuditLogs: entitlements.advancedAuditLogs,
          sso: entitlements.sso,
          dataExport: entitlements.dataExport,
          maxMembers: entitlements.maxMembers,
        },
      },
      key: {
        id: context.principal.apiKey.id,
        name: context.principal.apiKey.name,
        scopes: context.principal.scopes,
        expiresAt: context.principal.apiKey.expires_at,
      },
    });
  });
}
