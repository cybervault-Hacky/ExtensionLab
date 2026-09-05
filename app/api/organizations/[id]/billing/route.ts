import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { getOrganizationView, setOrganizationPlan } from "@/lib/organizations/service";
import { getOrganizationEntitlements, seatUsage } from "@/lib/organizations/entitlements";
import { listPlans } from "@/lib/billing/config";
import { getBillingProvider, isBillingEnabled } from "@/lib/billing/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET — billing overview: plan, seats (active/invited/available/max) and the
 * entitlement matrix. Server-authoritative; the client renders what it is told.
 */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:billing:manage");
    const organization = getOrganizationView(ctx, id);
    return NextResponse.json({
      organization,
      seats: seatUsage(id),
      entitlements: getOrganizationEntitlements(id),
      plans: listPlans().map((plan) => ({ id: plan.id, name: plan.name })),
      // Documented limitation: seat counts sync via the provider; when the
      // provider cannot update seats automatically an operator applies changes.
      providerCapabilities: isBillingEnabled() ? getBillingProvider().capabilities : null,
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST — change the organization plan (owner; goes through the provider). */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    authorizeOrgAction(id, user.id, "org:billing:manage");
    const body = (await request.json().catch(() => null)) as { planId?: unknown; seats?: unknown } | null;
    if (!body || (body.planId !== "free" && body.planId !== "pro" && body.planId !== "business")) throw badRequest("planId must be free, pro or business.");
    const seats = typeof body.seats === "number" && Number.isFinite(body.seats) ? Math.max(1, Math.min(Math.floor(body.seats), 500)) : undefined;
    setOrganizationPlan({ organizationId: id, planId: body.planId, status: "active", actorUserId: user.id, ...(seats ? { seats } : {}) });
    return NextResponse.json({ organization: getOrganizationView({ userId: user.id }, id), seats: seatUsage(id) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
