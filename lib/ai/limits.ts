import "server-only";
import { AIError } from "./errors";

/**
 * Concurrency gates for provider calls. Rate limits per minute live in the
 * shared policy (`enforceRateLimit("aiRequest", …)`); quotas per billing
 * period live in the entitlement service. This module only bounds how many
 * provider calls may be *in flight* at once, globally and per user, so one
 * user cannot monopolize the provider and a slow provider cannot pile up
 * requests inside the web process.
 */

let globalInFlight = 0;
const perUserInFlight = new Map<string, number>();

export interface ConcurrencySlot {
  release(): void;
}

export function acquireSlot(userId: string, limits: { global: number; perUser: number }): ConcurrencySlot {
  const mine = perUserInFlight.get(userId) ?? 0;
  if (mine >= limits.perUser) {
    throw new AIError("AI_RATE_LIMITED", { message: "An AI analysis is already in progress. Please wait for it to finish." });
  }
  if (globalInFlight >= limits.global) {
    throw new AIError("AI_UNAVAILABLE", { message: "AI analysis is busy right now. Please try again in a moment." });
  }
  globalInFlight += 1;
  perUserInFlight.set(userId, mine + 1);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      globalInFlight = Math.max(0, globalInFlight - 1);
      const current = perUserInFlight.get(userId) ?? 1;
      if (current <= 1) perUserInFlight.delete(userId);
      else perUserInFlight.set(userId, current - 1);
    },
  };
}

/** Test/ops helper. */
export function concurrencySnapshot(): { global: number; users: number } {
  return { global: globalInFlight, users: perUserInFlight.size };
}

export function resetConcurrencyForTests(): void {
  globalInFlight = 0;
  perUserInFlight.clear();
}

/** UTF-8 byte length without allocating a Buffer for every call site. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Rejects request bodies above the configured size before they are parsed. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AIError("AI_CONTEXT_TOO_LARGE", { message: "The request is too large." });
  }
  const text = await request.text();
  if (byteLength(text) > maxBytes) {
    throw new AIError("AI_CONTEXT_TOO_LARGE", { message: "The request is too large." });
  }
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AIError("INVALID_INPUT", { message: "Invalid request body." });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError("INVALID_INPUT", { message: "Invalid request body." });
  }
}
