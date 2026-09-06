import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { verifyPassword } from "@/lib/auth/password";
import { findUserByEmail, toUserRecord } from "@/lib/db/repositories/users";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  rateLimited,
  requireSameOrigin,
} from "@/lib/auth/api";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { normalizeEmail } from "@/lib/auth/validation";
import { setSessionCookie, startSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalidCredentials(): ApiError {
  // Generic message used for both unknown email and wrong password.
  return new ApiError(401, "unauthorized", "Email or password is incorrect.");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const ip = getClientIp(request);
    const limit = await enforceRateLimitAsync("login", ip);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw badRequest("Invalid request body.");
    const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) throw invalidCredentials();

    const user = findUserByEmail(email);
    if (!user || user.status !== "active") throw invalidCredentials();
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) throw invalidCredentials();

    const session = await startSession(request, user.id);
    const response = NextResponse.json(
      { user: toUserRecord(user), session: { id: session.session.id } },
      { status: 200 },
    );
    setSessionCookie(response, session.token);
    recordAuditEvent({ userId: user.id, type: "login" });
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
