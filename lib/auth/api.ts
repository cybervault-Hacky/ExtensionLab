import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getApiUser } from "./session";
import { isSameOrigin } from "./csrf";
import type { UserRecord } from "@/lib/db/repositories/users";
import { generateReferenceId } from "@/lib/runtime/ids";
import { AppError, ERROR_CATALOG, LEGACY_CODE_MAP, classifyError, type ErrorCode } from "@/lib/observability/errors";
import { generateRequestId, logger, resolveRequestId } from "@/lib/observability/logger";
import { QuotaExceededError } from "@/lib/db/repositories/quota";
import type { UsageKind } from "@/lib/db/repositories/usage";
import type { EntitlementResult, QuotaDenial } from "@/lib/billing/entitlements";
import { getPlan } from "@/lib/billing/config";
import type { PlanId } from "@/lib/billing/types";

type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "limit_reached"
  | "conflict"
  | "invalid_input"
  | "unavailable"
  | "internal";

/**
 * Phase 5 API error. Kept for backwards compatibility; responses now also
 * carry the stable Phase 6 `errorCode` and a `req_…` reference for support.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly referenceId: string;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.referenceId = generateReferenceId();
  }
}

export function requireApiUser(request: NextRequest): UserRecord {
  const user = getApiUser(request);
  if (!user) {
    throw new ApiError(401, "unauthorized", "Sign in to continue.");
  }
  return user;
}

export function requireSameOrigin(request: NextRequest): void {
  if (!isSameOrigin(request)) {
    throw new ApiError(403, "forbidden", "This request could not be verified.");
  }
}

export const badRequest = (message: string) =>
  new ApiError(400, "bad_request", message);

export const notFound = () =>
  new ApiError(404, "not_found", "Resource not found.");

export const unauthorized = () =>
  new ApiError(401, "unauthorized", "Sign in to continue.");

export const forbidden = () =>
  new ApiError(403, "forbidden", "You don't have permission to access this resource.");

export const rateLimited = (seconds: number) =>
  new ApiError(
    429,
    "rate_limited",
    `Too many requests. Please try again in ${Math.max(1, seconds)} second(s).`,
  );

export const usageLimit = (label: string) =>
  new ApiError(429, "limit_reached", `Your plan's ${label} limit has been reached.`);

/**
 * Structured details attached to plan/quota denials so the client can render
 * a paywall without guessing: `{ currentUsage, limit, resetAt, requiredPlan }`.
 */
export interface EntitlementDetails {
  reason: "quota" | "plan" | "size";
  kind?: UsageKind;
  currentUsage?: number;
  limit?: number;
  resetAt?: number;
  maxExtensionSize?: number;
  plan: PlanId;
  requiredPlan: PlanId | null;
  requiredPlanName: string | null;
}

/** Thrown when the entitlement service denies an operation. */
export class EntitlementError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly errorCode: ErrorCode;
  readonly details: EntitlementDetails;
  readonly referenceId: string;

  constructor(status: number, code: ApiErrorCode, errorCode: ErrorCode, message: string, details: EntitlementDetails) {
    super(message);
    this.name = "EntitlementError";
    this.status = status;
    this.code = code;
    this.errorCode = errorCode;
    this.details = details;
    this.referenceId = generateReferenceId();
  }
}

const KIND_LABEL: Record<UsageKind, string> = { analysis: "analysis", test_run: "automated test run", ai_request: "AI assistance", interactive_browser: "interactive browser session" };

function planName(planId: PlanId | null): string | null {
  return planId ? getPlan(planId).name : null;
}

export function quotaDenialDetails(denial: QuotaDenial): EntitlementDetails {
  return {
    reason: "quota",
    kind: denial.kind,
    currentUsage: denial.currentUsage,
    limit: denial.limit,
    resetAt: denial.resetAt,
    plan: denial.planId,
    requiredPlan: denial.requiredPlan,
    requiredPlanName: planName(denial.requiredPlan),
  };
}

function quotaMessage(denial: QuotaDenial): string {
  const plan = getPlan(denial.planId).name;
  const upgrade = denial.requiredPlan ? ` Upgrade to ${getPlan(denial.requiredPlan).name} for more.` : "";
  if (denial.kind === "ai_request") {
    return `AI usage limit reached. Your ${plan} plan includes ${denial.limit} AI requests per billing period.${upgrade}`;
  }
  return `Your ${plan} plan ${KIND_LABEL[denial.kind]} limit (${denial.limit} per billing period) has been reached.${upgrade}`;
}

/**
 * Converts an entitlement verdict into the API error to throw. Callers write
 * `assertEntitled(canAnalyze(user.id))` and never compare plans themselves.
 */
export function assertEntitled(result: EntitlementResult, currentPlan?: PlanId): void {
  if (result.allowed) return;
  if (result.reason === "quota") {
    throw new EntitlementError(
      429,
      "limit_reached",
      result.quota.kind === "ai_request" ? "AI_QUOTA_EXCEEDED" : "QUOTA_EXCEEDED",
      quotaMessage(result.quota),
      quotaDenialDetails(result.quota),
    );
  }
  const plan = currentPlan ?? "free";
  if (result.reason === "size") {
    const mb = Math.floor(result.maxExtensionSize / (1024 * 1024));
    throw new EntitlementError(413, "limit_reached", "PAYMENT_REQUIRED", `This extension is larger than your plan's ${mb} MB limit.`, {
      reason: "size",
      maxExtensionSize: result.maxExtensionSize,
      plan,
      requiredPlan: result.requiredPlan,
      requiredPlanName: planName(result.requiredPlan),
    });
  }
  throw new EntitlementError(402, "limit_reached", "PAYMENT_REQUIRED", result.message, {
    reason: "plan",
    plan,
    requiredPlan: result.requiredPlan,
    requiredPlanName: planName(result.requiredPlan),
  });
}

/** Request id from the incoming header (validated) or freshly generated. */
export function requestIdFrom(request: NextRequest | Request | undefined): string {
  return resolveRequestId(request?.headers.get("x-request-id") ?? null);
}

export interface ApiErrorBody {
  error: {
    code: string;
    errorCode: ErrorCode;
    message: string;
    referenceId: string;
    requestId: string;
    /** Present for QUOTA_EXCEEDED / PAYMENT_REQUIRED: what was hit and which plan lifts it. */
    details?: EntitlementDetails;
  };
}

/**
 * Converts any thrown value into a safe JSON response. Unknown errors never
 * leak their message; every response carries `Reference: req_…` material so
 * users can quote it to support and operators can grep the logs.
 */
export function apiErrorResponse(error: unknown, request?: NextRequest | Request): NextResponse {
  const requestId = requestIdFrom(request);
  const { status, code, errorCode, message, referenceId, details } = describeError(error);
  const level = status >= 500 ? "error" : "warn";
  logger[level]("api.error", {
    requestId,
    errorCode,
    status,
    result: "error",
    ...(error instanceof Error && status >= 500 ? { errorName: error.name } : {}),
  });
  const body: ApiErrorBody = {
    error: { code, errorCode, message: `${message}`, referenceId, requestId, ...(details ? { details } : {}) },
  };
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId } });
}

function describeError(error: unknown): {
  status: number;
  code: string;
  errorCode: ErrorCode;
  message: string;
  referenceId: string;
  details?: EntitlementDetails;
} {
  if (error instanceof EntitlementError) {
    return {
      status: error.status,
      code: error.code,
      errorCode: error.errorCode,
      message: error.message,
      referenceId: error.referenceId,
      details: error.details,
    };
  }
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      errorCode: LEGACY_CODE_MAP[error.code] ?? "INTERNAL",
      message: error.message,
      referenceId: error.referenceId,
    };
  }
  if (error instanceof AppError) {
    return {
      status: error.status === 200 ? 400 : error.status,
      code: legacyCodeFor(error.code),
      errorCode: error.code,
      message: error.userMessage,
      referenceId: generateReferenceId(),
    };
  }
  if (error instanceof QuotaExceededError) {
    const denial: QuotaDenial = error.denial ?? {
      kind: error.kind,
      currentUsage: error.snapshot.used + error.snapshot.reserved,
      limit: error.snapshot.limit,
      resetAt: error.snapshot.resetAt,
      planId: "free",
      requiredPlan: null,
    };
    return {
      status: 429,
      code: "limit_reached",
      errorCode: denial.kind === "ai_request" ? "AI_QUOTA_EXCEEDED" : "QUOTA_EXCEEDED",
      message: quotaMessage(denial),
      referenceId: generateReferenceId(),
      details: quotaDenialDetails(denial),
    };
  }
  const structured = error as { code?: unknown; message?: unknown; referenceId?: unknown } | null;
  if (structured && typeof structured === "object" && typeof structured.code === "string" && LEGACY_CODE_MAP[structured.code]) {
    // Sandbox / test-runner errors carry safe messages by construction.
    const errorCode = LEGACY_CODE_MAP[structured.code];
    return {
      status: ERROR_CATALOG[errorCode].status === 200 ? 409 : ERROR_CATALOG[errorCode].status,
      code: legacyCodeFor(errorCode),
      errorCode,
      message: typeof structured.message === "string" ? structured.message : ERROR_CATALOG[errorCode].message,
      referenceId: typeof structured.referenceId === "string" ? structured.referenceId : generateReferenceId(),
    };
  }
  const classified = classifyError(error);
  return {
    status: classified.code === "INTERNAL" ? 500 : ERROR_CATALOG[classified.code].status,
    code: "internal",
    errorCode: classified.code,
    message: classified.userMessage,
    referenceId: generateReferenceId(),
  };
}

function legacyCodeFor(code: ErrorCode): ApiErrorCode {
  switch (code) {
    case "AUTH_REQUIRED":
      return "unauthorized";
    case "FORBIDDEN":
      return "forbidden";
    case "NOT_FOUND":
      return "not_found";
    case "INVALID_INPUT":
    case "INVALID_EXTENSION":
      return "invalid_input";
    case "RATE_LIMITED":
      return "rate_limited";
    case "QUOTA_EXCEEDED":
    case "CONCURRENCY_LIMIT":
      return "limit_reached";
    case "CONFLICT":
    case "JOB_CANCELLED":
    case "SUBSCRIPTION_STATE_INVALID":
      return "conflict";
    case "INVALID_PLAN":
    case "WEBHOOK_SIGNATURE_INVALID":
      return "bad_request";
    case "SUBSCRIPTION_NOT_FOUND":
      return "not_found";
    case "PAYMENT_REQUIRED":
    case "AI_QUOTA_EXCEEDED":
      return "limit_reached";
    case "AI_RATE_LIMITED":
      return "rate_limited";
    case "AI_UNAUTHORIZED_CONTEXT":
      return "not_found";
    case "AI_CONTEXT_TOO_LARGE":
      return "bad_request";
    case "AI_NOT_CONFIGURED":
    case "AI_UNAVAILABLE":
    case "AI_PROVIDER_ERROR":
    case "AI_TIMEOUT":
    case "AI_INVALID_OUTPUT":
      return "unavailable";
    default:
      return "internal";
  }
}

/** Adds the request id header to successful responses. */
export function withRequestId<T extends Response>(response: T, request?: NextRequest | Request): T {
  response.headers.set("x-request-id", requestIdFrom(request) || generateRequestId());
  return response;
}
