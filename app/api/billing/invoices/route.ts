import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, rateLimited, requireApiUser } from "@/lib/auth/api";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { listInvoices } from "@/lib/billing/billing-service";
import { getClientIp } from "@/lib/runtime/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/billing/invoices — the user's own invoices (provider-hosted URLs). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const limit = enforceRateLimit("billingRead", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const invoices = await listInvoices(user);
    return NextResponse.json({ invoices }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
