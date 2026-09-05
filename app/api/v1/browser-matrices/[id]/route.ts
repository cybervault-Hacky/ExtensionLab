import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey } from "@/lib/api/v1-support";
import { getMatrixRunViewForOrganization } from "@/lib/testing/matrix-service";
import { getOrganizationPolicyRules, evaluatePolicy, evidenceForMatrixRun } from "@/lib/policies/service";
import { getOrgMatrixRun } from "@/lib/db/repositories/browser-matrix";
import { AppError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/browser-matrices/:id — matrix view + comparison +, when the
 * organization configured CI quality gates, the deterministic policy verdict.
 * The verdict is recomputed server-side from stored evidence on every read.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  return withApiKey(request, { scope: "browser-matrix:read", rateClass: "read" }, async (apiContext) => {
    const view = getMatrixRunViewForOrganization(apiContext.principal.organizationId, id);
    if (!view) throw new AppError("NOT_FOUND");
    let policy = null;
    const rules = getOrganizationPolicyRules(apiContext.principal.organizationId);
    if (rules) {
      const matrix = getOrgMatrixRun(apiContext.principal.organizationId, id);
      if (matrix) policy = evaluatePolicy(rules, evidenceForMatrixRun(matrix));
    }
    return NextResponse.json({ browserMatrix: view, ...(policy ? { policy } : {}) });
  });
}
