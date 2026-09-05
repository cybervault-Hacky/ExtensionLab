import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hashPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/validation";
import { findPasswordReset, markPasswordResetUsed, invalidateUserPasswordResets } from "@/lib/db/repositories/password-resets";
import { updateUserPassword } from "@/lib/db/repositories/users";
import { deleteAllSessionsForUser } from "@/lib/db/repositories/sessions";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import { ApiError, apiErrorResponse, badRequest, rateLimited, requireSameOrigin } from "@/lib/auth/api";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { hashToken } from "@/lib/auth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const ip = getClientIp(request);
    const limit = checkRateLimit(`reset-apply:${ip}`, 20, 60 * 1000);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw badRequest("Invalid request body.");
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!token) throw new ApiError(400, "invalid_input", "The reset token is invalid or expired.");
    const passwordResult = validatePassword(password);
    if (!passwordResult.ok) throw badRequest(passwordResult.message ?? "Invalid password.");

    const reset = findPasswordReset(hashToken(token));
    if (!reset || reset.used_at !== null || reset.expires_at <= Date.now()) {
      throw new ApiError(400, "invalid_input", "The reset token is invalid or expired.");
    }

    const newHash = await hashPassword(password);
    updateUserPassword(reset.user_id, newHash);
    markPasswordResetUsed(reset.id, Date.now());
    invalidateUserPasswordResets(reset.user_id);
    deleteAllSessionsForUser(reset.user_id);
    recordAuditEvent({ userId: reset.user_id, type: "password_reset" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
