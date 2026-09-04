import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { sanitizeError } from "./security";
import { SandboxRuntimeError } from "./errors";
import { validateTestUrlWithDns } from "./urls";
import { generateSandboxId, generateSessionToken } from "./ids";

export function getSandboxToken(request: NextRequest): string {
  return request.headers.get("x-sandbox-token") ?? "";
}

export function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function validateIncomingTestUrl(
  value: string | null,
): Promise<{ ok: boolean; url?: string; reason?: string }> {
  if (!value || value.trim() === "") {
    return { ok: true };
  }
  const validated = await validateTestUrlWithDns(value);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason ?? "This URL cannot be tested from the sandbox." };
  }
  return { ok: true, url: validated.url };
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof SandboxRuntimeError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          referenceId: error.referenceId,
        },
      },
      { status: error.code === "not_found" || error.code === "unauthorized" ? 403 : 409 },
    );
  }

  const clean = sanitizeError(error instanceof Error ? error.message : "Sandbox failed.");
  return NextResponse.json(
    { error: { code: "internal", message: clean.message, referenceId: clean.referenceId } },
    { status: 500 },
  );
}

export function createMockSession(): { sandboxId: string; sessionToken: string } {
  return { sandboxId: generateSandboxId(), sessionToken: generateSessionToken() };
}
