import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  requireApiUser,
  requireSameOrigin,
} from "@/lib/auth/api";
import { getActivePlan } from "@/lib/db/plan";
import { countUsageThisMonth } from "@/lib/db/repositories/usage";
import { getActiveUserSessions, clearSessionCookie, logoutAllSessions } from "@/lib/auth/session";
import {
  findUserByEmail,
  findUserById,
  updateUserPassword,
  updateUserProfile,
  deleteUser,
} from "@/lib/db/repositories/users";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { normalizeEmail, isValidEmail, validateName, validatePassword } from "@/lib/auth/validation";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import { transaction, getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const plan = getActivePlan();
    const currentUser = user;
    return NextResponse.json({
      user: currentUser,
      plan: {
        id: plan.id,
        name: plan.name,
        analysisLimit: plan.analysisLimit,
        testRunLimit: plan.testRunLimit,
        maxExtensionSize: plan.maxExtensionSize,
        maxConcurrentRuns: plan.maxConcurrentRuns,
        historyRetentionDays: plan.historyRetentionDays,
      },
      usage: {
        analysisUsed: countUsageThisMonth(user.id, "analysis"),
        testRunUsed: countUsageThisMonth(user.id, "test_run"),
      },
      activeSessions: getActiveUserSessions(user.id),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw badRequest("Invalid request body.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const nameResult = validateName(name);
    if (!nameResult.ok) throw badRequest(nameResult.message ?? "Invalid name.");

    const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
    if (!isValidEmail(email)) throw badRequest("Enter a valid email address.");
    const existing = findUserByEmail(email);
    if (existing && existing.id !== user.id) {
      throw new ApiError(409, "conflict", "This email is already in use.");
    }

    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const fullUser = findUserById(user.id);
    if (!fullUser || fullUser.status !== "active") throw badRequest("Current password is incorrect.");
    const valid = await verifyPassword(currentPassword, fullUser.password_hash);
    if (!valid) throw badRequest("Current password is incorrect.");

    const profile = updateUserProfile(user.id, { name, email });
    if (body.newPassword) {
      const passwordResult = validatePassword(String(body.newPassword));
      if (!passwordResult.ok) throw badRequest(passwordResult.message ?? "Invalid new password.");
      const nextHash = await hashPassword(String(body.newPassword));
      updateUserPassword(user.id, nextHash);
      // Rotate out every other session after a password change.
      logoutAllSessions(user.id);
      recordAuditEvent({ userId: user.id, type: "password_change", detail: "Password changed from account settings." });
    }

    return NextResponse.json({ user: profile });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.confirm !== true) {
      throw badRequest("Account deletion must be confirmed.");
    }

    recordAuditEvent({ userId: user.id, type: "account_delete", detail: "Account and owned data deleted." });
    transaction(getDb(), () => {
      deleteUser(user.id);
    });

    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
