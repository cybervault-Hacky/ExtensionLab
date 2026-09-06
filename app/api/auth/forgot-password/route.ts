import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { normalizeEmail } from "@/lib/auth/validation";
import { findUserByEmail } from "@/lib/db/repositories/users";
import { apiErrorResponse, badRequest, rateLimited, requireSameOrigin } from "@/lib/auth/api";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { issuePasswordReset } from "@/lib/auth/password-reset-service";
import { logger } from "@/lib/observability/logger";
import { classifyError } from "@/lib/observability/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const ip = getClientIp(request);
    const limit = await enforceRateLimitAsync("forgotPassword", ip);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw badRequest("Invalid request body.");
    const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
    if (!email) throw badRequest("Enter a valid email address.");

    // Per-address limit prevents mailbox flooding independent of the client IP.
    const perAddress = checkRateLimit(`reset-email:${email}`, 5, 60 * 60 * 1000);
    const user = perAddress.ok ? findUserByEmail(email) : null;
    if (user) {
      try {
        await issuePasswordReset({ id: user.id, email: user.email });
      } catch (error) {
        // Never reveal delivery problems (or account existence) to the caller.
        logger.error("auth.password_reset.enqueue_failed", { userId: user.id, errorCode: classifyError(error).code });
      }
    }

    // Always return the same public response so account existence is not
    // revealed by this endpoint.
    return NextResponse.json({
      message: "If an account exists for this email, instructions will be sent.",
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
