import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  requireApiUser,
  requireSameOrigin,
} from "@/lib/auth/api";
import { getOwnedReport } from "@/lib/db/repositories/reports";
import { createShare, getActiveShareForReport, revokeShare } from "@/lib/db/repositories/shares";
import { generateShareToken } from "@/lib/db/ids";
import { isSafeId } from "@/lib/auth/validation";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { rateLimited } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedExpirationHours = [0, 24, 168, 720];

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const limit = enforceRateLimit("shareCreate", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new ApiError(404, "not_found", "Report not found.");
    const report = getOwnedReport(user.id, id);
    if (!report) throw new ApiError(404, "not_found", "Report not found.");

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const expiresInHours = body?.expiresInHours;
    if (expiresInHours !== undefined && !allowedExpirationHours.includes(Number(expiresInHours))) {
      throw badRequest("Invalid expiration.");
    }
    const expiresAt =
      Number(expiresInHours) > 0 ? Date.now() + Number(expiresInHours) * 60 * 60 * 1000 : null;

    // Revoke any previous live link so the token rotates on every share request.
    const active = getActiveShareForReport(report.id);
    if (active) revokeShare(active.id);

    const token = generateShareToken();
    const share = createShare({ reportId: report.id, token, expiresAt });
    recordAuditEvent({ userId: user.id, type: "share_created", detail: `Report ${report.id}` });
    return NextResponse.json(
      { token, url: `/report/shared/${token}`, expiresAt: share.expires_at },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new ApiError(404, "not_found", "Report not found.");
    const report = getOwnedReport(user.id, id);
    if (!report) throw new ApiError(404, "not_found", "Report not found.");
    const active = getActiveShareForReport(report.id);
    if (active) {
      revokeShare(active.id);
      recordAuditEvent({ userId: user.id, type: "share_revoked", detail: `Report ${report.id}` });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
