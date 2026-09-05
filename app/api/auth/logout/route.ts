import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { clearSessionCookie, endSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getApiUser } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import { apiErrorResponse, requireSameOrigin } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = getApiUser(request);
    const token = request.cookies.get(SESSION_COOKIE)?.value ?? "";
    if (user) recordAuditEvent({ userId: user.id, type: "logout" });
    endSession(request, token);
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
