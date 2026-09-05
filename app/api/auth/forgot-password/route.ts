import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { normalizeEmail } from "@/lib/auth/validation";
import { findUserByEmail } from "@/lib/db/repositories/users";
import { generateResetToken, hashToken } from "@/lib/auth/tokens";
import { createPasswordReset, invalidateUserPasswordResets } from "@/lib/db/repositories/password-resets";
import { apiErrorResponse, badRequest, rateLimited, requireSameOrigin } from "@/lib/auth/api";
import { checkRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const ip = getClientIp(request);
    const limit = checkRateLimit(`reset:${ip}`, 10, 60 * 1000);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw badRequest("Invalid request body.");
    const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
    if (!email) throw badRequest("Enter a valid email address.");

    const user = findUserByEmail(email);
    if (user) {
      invalidateUserPasswordResets(user.id);
      const token = generateResetToken();
      const expiresAt = Date.now() + 30 * 60 * 1000;
      createPasswordReset({ userId: user.id, tokenHash: hashToken(token), expiresAt });

      const devDir = process.env.EXTENSIONLAB_RESET_DEV_DIR;
      if (devDir) {
        // Development-only file-based reset-token delivery. Never used in
        // production and never written to application logs.
        await mkdir(devDir, { recursive: true }).catch(() => undefined);
        await writeFile(join(devDir, `${user.id}.reset-token`), token, "utf8").catch(() => undefined);
      }
    }

    // Always return the same public response so account existence is not
    // revealed by this endpoint.
    return NextResponse.json({
      message: "If an account exists for this email, instructions will be sent.",
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
