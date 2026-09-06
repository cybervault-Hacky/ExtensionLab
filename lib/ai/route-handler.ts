import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, assertEntitled, requestIdFrom, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { canUseAI, getEffectivePlan } from "@/lib/billing/entitlements";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { withLogContext } from "@/lib/observability/logger";
import { getAISettings } from "./config";
import { AIError } from "./errors";
import { readBoundedJson } from "./limits";
import { isAIEnabled } from "./provider";
import { runAIFeature } from "./service";
import { loadReportSource, loadSnapshotSource, loadTestRunSource } from "./sources";
import type { AIFeature } from "./types";
import { recordAIRequest, resultForErrorCode } from "./usage";

/**
 * Shared request pipeline for every /api/ai/* route:
 *
 *   same-origin → session → per-user rate limit → entitlement (plan + quota)
 *   → bounded JSON body → owner-scoped resource load → AIService.
 *
 * Routes only declare which feature they serve and how to read their body.
 * Public share tokens never reach this code path: there is no token
 * parameter, and `requireApiUser` demands a session cookie.
 */

export interface AIRouteSpec {
  feature: AIFeature;
  parse(body: Record<string, unknown>): {
    resource: { kind: "report" | "test_run" | "snapshot"; id: string; withRuntimeEvidence?: boolean };
    focus?: { findingId?: string; testId?: string; question?: string };
    targetId?: string | null;
  };
}

const ID_MAX = 80;

export function optionalId(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > ID_MAX) throw new AIError("INVALID_INPUT", { message: `Invalid ${key}.` });
  return value;
}

export function requiredId(body: Record<string, unknown>, key: string): string {
  const value = optionalId(body, key);
  if (!value) throw new AIError("INVALID_INPUT", { message: `${key} is required.` });
  return value;
}

/** Finding / test ids are analyzer-generated slugs; keep them short and printable. */
export function requiredTargetId(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > 160 || /[\u0000-\u001f]/.test(value)) {
    throw new AIError("INVALID_INPUT", { message: `${key} is required.` });
  }
  return value.trim();
}

export function questionHash(question: string): string {
  return createHash("sha256").update(question.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export function createAIRoute(spec: AIRouteSpec): (request: NextRequest) => Promise<NextResponse> {
  return async function POST(request: NextRequest): Promise<NextResponse> {
    const requestId = requestIdFrom(request);
    return withLogContext({ requestId }, async () => {
      const startedAt = Date.now();
      let userId: string | null = null;
      let serviceStarted = false;
      try {
        requireSameOrigin(request);
        const user = requireApiUser(request);
        userId = user.id;

        // Per-user AI rate limit, independent of the analysis/test limits.
        const rate = await enforceRateLimitAsync("aiRequest", `${user.id}:${getClientIp(request)}`);
        if (!rate.ok) throw new AIError("AI_RATE_LIMITED", { message: `Too many AI requests. Please try again in ${rate.retryAfterSeconds} second(s).` });

        // Configuration gate before any plan check: an unconfigured deployment
        // must not send Free users to a paywall for a feature nobody can use.
        if (!isAIEnabled()) throw new AIError("AI_NOT_CONFIGURED");

        // Plan feature gate (402 with paywall details). The period quota is
        // enforced by the service when it reserves a request, which happens
        // after the cache lookup: results a user already paid for stay
        // readable when the allowance is exhausted, new generations are 429.
        const entitlement = canUseAI(user.id);
        if (!entitlement.allowed && entitlement.reason === "plan") {
          assertEntitled(entitlement, getEffectivePlan(user.id).plan.id);
        }

        const body = await readBoundedJson(request, getAISettings().maxRequestBytes);
        const parsed = spec.parse(body);
        const source =
          parsed.resource.kind === "report"
            ? loadReportSource(user.id, parsed.resource.id)
            : parsed.resource.kind === "test_run"
              ? await loadTestRunSource(user.id, parsed.resource.id, parsed.resource.withRuntimeEvidence ?? false)
              : loadSnapshotSource(user.id, parsed.resource.id);

        serviceStarted = true;
        const result = await runAIFeature({
          requestId,
          userId: user.id,
          feature: spec.feature,
          source,
          focus: parsed.focus,
          targetId: parsed.targetId ?? null,
        });
        return NextResponse.json(result, { status: 200, headers: { "x-request-id": requestId } });
      } catch (error) {
        // The service accounts for everything it handled; rejections before it
        // ran (rate limit, plan, bad input, ownership) are recorded here so
        // operators see every rejected AI request.
        if (userId && !serviceStarted) {
          const raw = (error as { errorCode?: unknown; code?: unknown } | null) ?? {};
          const code = typeof raw.errorCode === "string" ? raw.errorCode : typeof raw.code === "string" ? raw.code : undefined;
          recordAIRequest({
            requestId,
            userId,
            feature: spec.feature,
            provider: "none",
            model: null,
            durationMs: Date.now() - startedAt,
            result: resultForErrorCode(code),
            errorCode: code,
          });
        }
        return apiErrorResponse(error, request);
      }
    });
  };
}
