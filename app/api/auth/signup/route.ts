import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { hashPassword } from "@/lib/auth/password";
import { normalizeEmail, isValidEmail, validateName, validatePassword } from "@/lib/auth/validation";
import { createUser, findUserByEmail } from "@/lib/db/repositories/users";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  rateLimited,
  requireSameOrigin,
} from "@/lib/auth/api";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { setSessionCookie, startSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const ip = getClientIp(request);
    const limit = await enforceRateLimitAsync("signup", ip);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw badRequest("Invalid request body.");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const rawEmail = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";

    const email = normalizeEmail(rawEmail);
    if (!email || !isValidEmail(email)) throw badRequest("Enter a valid email address.");
    const nameResult = validateName(name);
    if (!nameResult.ok) throw badRequest(nameResult.message ?? "Invalid name.");
    const passwordResult = validatePassword(password);
    if (!passwordResult.ok) throw badRequest(passwordResult.message ?? "Invalid password.");

    if (findUserByEmail(email)) {
      throw new ApiError(409, "conflict", "An account could not be created with those details.");
    }

    const passwordHash = await hashPassword(password);
    const user = createUser({ email, passwordHash, name });
    const session = await startSession(request, user.id);
    const response = NextResponse.json({ user, session: { id: session.session.id } }, { status: 201 });
    setSessionCookie(response, session.token);
    recordAuditEvent({ userId: user.id, type: "signup" });
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
