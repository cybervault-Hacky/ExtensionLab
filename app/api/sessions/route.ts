import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { getActiveUserSessions, logoutAllSessions, SESSION_COOKIE } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/db/repositories/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    return NextResponse.json({ sessions: getActiveUserSessions(user.id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const current = request.cookies.get(SESSION_COOKIE)?.value;
    logoutAllSessions(user.id, current);
    recordAuditEvent({ userId: user.id, type: "logout", detail: "Logged out all other sessions." });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
