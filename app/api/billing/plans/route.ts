import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/auth/api";
import { getPlanCatalog, toPlanView } from "@/lib/billing/config";
import { formatPlanAmount, orderedPlans, planComparisonRows } from "@/lib/billing/plans";
import { isBillingEnabled } from "@/lib/billing/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/billing/plans — public plan catalog (same source as entitlements). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const catalog = getPlanCatalog();
    return NextResponse.json(
      {
        billingEnabled: isBillingEnabled(),
        plans: orderedPlans(catalog).map((plan) => toPlanView(plan, formatPlanAmount(plan))),
        comparison: planComparisonRows(catalog),
      },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
