import "server-only";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config/env";
import { getCoordinationStore } from "@/lib/coordination";
import { AppError, classifyError } from "@/lib/observability/errors";
import { generateRequestId, logger } from "@/lib/observability/logger";
import { getMembership } from "@/lib/organizations/repository";
import { authenticateApiKey, type ApiKeyPrincipal, type ApiScope } from "@/lib/api-keys/service";
import type { OrgAction } from "@/lib/organizations/types";
import { roleHasPermission } from "@/lib/organizations/types";

/**
 * Public API (v1) plumbing: authentication, scoped authorization, per-key
 * rate limiting with response headers, and the standardized error model.
 *
 * Limits are enforced per API key AND per organization AND per IP — the
 * strictest applicable bucket denies the request. API rate limiting is
 * separate from workload quotas: an API call can never bypass the job
 * system's concurrency/usage checks, which keep running inside the handlers.
 */

export type ApiRateClass = "read" | "upload" | "analysis" | "test" | "matrix" | "report";

export function rateLimitForClass(className: ApiRateClass): number {
  return getConfig().publicApi.rateLimits[className];
}

export interface ApiContext {
  principal: ApiKeyPrincipal;
  requestId: string;
  ip: string;
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export interface ApiRateMetadata {
  limit: number;
  remaining: number;
  /** Epoch seconds when the window resets. */
  resetAt: number;
}

async function enforceApiRateLimit(className: ApiRateClass, request: NextRequest, principal: ApiKeyPrincipal): Promise<ApiRateMetadata> {
  const config = getConfig();
  if (!config.publicApi.enabled) throw new AppError("API_DISABLED");
  const store = await getCoordinationStore();
  const limit = rateLimitForClass(className);
  const windowMs = 60_000;
  const ip = clientIp(request);
  const effectiveLimit = className === "read" ? Math.max(limit, 600) : limit;
  let metadata: ApiRateMetadata = { limit: effectiveLimit, remaining: effectiveLimit, resetAt: Math.ceil((Date.now() + windowMs) / 1000) };
  // Three independent buckets; all must allow the request.
  for (const key of [`apikey:${principal.apiKey.id}`, `org:${principal.organizationId}:${className}`, `ip:${ip}`]) {
    const verdict = await store.rateLimit(`api:${className}:${key}`, effectiveLimit, windowMs);
    metadata = {
      limit: effectiveLimit,
      remaining: Math.min(metadata.remaining, verdict.remaining),
      resetAt: Math.ceil((Date.now() + verdict.retryAfterSeconds * 1000) / 1000),
    };
    if (!verdict.ok) {
      throw new AppError("RATE_LIMITED", { message: "Too many API requests. Please try again later.", retryAfterSeconds: verdict.retryAfterSeconds });
    }
  }
  return metadata;
}

export interface ApiRouteOptions {
  scope?: ApiScope;
  rateClass?: ApiRateClass;
  /** Organization-level RBAC action the key creator's role must hold. */
  action?: OrgAction;
}

/**
 * Standard v1 route wrapper: API-key auth → scope → org role → rate limits →
 * handler. Produces the documented error envelope with `requestId` headers.
 */
export async function withApiKey(
  request: NextRequest,
  options: ApiRouteOptions,
  handler: (context: ApiContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? generateRequestId();
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      // Cross-origin protection: API keys are not CSRF-bound, but the key
      // itself must be presented; browsers never attach it automatically.
    }
    const principal = authenticateApiKey(request, options.scope);
    if (options.action && !roleHasPermission(principal.creatorRole, options.action)) {
      throw new AppError("API_SCOPE_DENIED", { message: "The API key's role does not permit this action." });
    }
    let rate: ApiRateMetadata | null = null;
    if (options.rateClass) {
      rate = await enforceApiRateLimit(options.rateClass, request, principal);
    }
    const response = await handler({ principal, requestId, ip: clientIp(request) });
    response.headers.set("x-request-id", requestId);
    if (rate) {
      response.headers.set("x-ratelimit-limit", String(rate.limit));
      response.headers.set("x-ratelimit-remaining", String(Math.max(0, rate.remaining)));
      response.headers.set("x-ratelimit-reset", String(rate.resetAt));
    }
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

/** Standard public API error envelope. Never leaks internals. */
export function apiErrorResponse(error: unknown, requestId?: string): NextResponse {
  const classified = classifyError(error);
  const appError = error instanceof AppError ? error : null;
  const status = appError ? appError.status : 500;
  const headers: Record<string, string> = { "x-request-id": requestId ?? "" };
  if (appError?.retryAfterSeconds !== undefined && appError.retryAfterSeconds > 0) {
    headers["retry-after"] = String(appError.retryAfterSeconds);
  }
  const response = NextResponse.json(
    {
      error: {
        code: appError ? appError.code : classified.code,
        message: classified.userMessage,
        requestId: requestId ?? generateRequestId(),
      },
    },
    { status, headers },
  );
  if (status >= 500) {
    logger.error("api.v1.error", { requestId, errorCode: classified.code, errorName: error instanceof Error ? error.name : undefined });
  }
  return response;
}

/** Membership check for API-key paths: the key must belong to the org context. */
export function requireApiKeyOrganization(principal: ApiKeyPrincipal, organizationId: string | null): void {
  // API keys always act on their own organization; a different id is 404.
  if (organizationId && organizationId !== principal.organizationId) {
    throw new AppError("NOT_FOUND");
  }
}

export function memberRoleInPrincipalOrg(principal: ApiKeyPrincipal): string {
  const membership = getMembership(principal.organizationId, principal.apiKey.created_by);
  return membership?.role ?? "viewer";
}
