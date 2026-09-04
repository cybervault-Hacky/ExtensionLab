import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  deleteSession,
  deleteAllSessionsForUser,
  findSessionByTokenHash,
  touchSession,
  listActiveSessions,
} from "@/lib/db/repositories/sessions";
import { toUserRecord } from "@/lib/db/repositories/users";
import type { UserRecord } from "@/lib/db/repositories/users";
import { generateAuthToken, hashToken } from "./tokens";
import { isSafeId } from "./validation";

export const SESSION_COOKIE = "extensionlab_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export function sessionCookieOptions(ttlMs = SESSION_TTL_MS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  };
}

export function publicSessionCookieOptions() {
  return sessionCookieOptions(0);
}

function readUserAgent(request?: NextRequest): string | null {
  return request?.headers.get("user-agent")?.slice(0, 300) ?? null;
}

function readIp(request?: NextRequest): string | null {
  const forwarded = request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 120);
  return request?.headers.get("x-real-ip")?.trim().slice(0, 120) ?? null;
}

export async function startSession(request: NextRequest | undefined, userId: string) {
  const token = generateAuthToken();
  const session = createSession({
    userId,
    tokenHash: hashToken(token),
    userAgent: readUserAgent(request),
    ipAddress: readIp(request),
    ttlMs: SESSION_TTL_MS,
  });
  return { token, session };
}

export function restoreUser(sessionToken: string): UserRecord | null {
  if (!sessionToken || sessionToken.length < 32 || !isSafeId(sessionToken)) return null;
  const session = findSessionByTokenHash(hashToken(sessionToken));
  if (!session) return null;
  if (session.expires_at <= Date.now()) return null;
  if (session.user.status !== "active") return null;
  if (Date.now() - session.last_active_at > 60_000) {
    touchSession(session.id, Date.now());
  }
  return toUserRecord(session.user);
}

export function getApiUser(request: NextRequest): UserRecord | null {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  return token ? restoreUser(token) : null;
}

export function endSession(request: NextRequest | undefined, token: string): void {
  if (!token) return;
  const session = findSessionByTokenHash(hashToken(token));
  if (session) deleteSession(session.id);
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", publicSessionCookieOptions());
}

export function logoutAllSessions(userId: string, exceptToken?: string): void {
  let exceptId: string | undefined;
  if (exceptToken) {
    exceptId = findSessionByTokenHash(hashToken(exceptToken))?.id;
  }
  deleteAllSessionsForUser(userId, exceptId);
}

export function getActiveUserSessions(userId: string) {
  return listActiveSessions(userId);
}
