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

type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "limit_reached"
  | "conflict"
  | "invalid_input"
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
  new ApiError(429, "limit_reached", `Your Free plan ${label} limit has been reached.`);

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
  };
}

/**
 * Converts any thrown value into a safe JSON response. Unknown errors never
 * leak their message; every response carries `Reference: req_…` material so
 * users can quote it to support and operators can grep the logs.
 */
export function apiErrorResponse(error: unknown, request?: NextRequest | Request): NextResponse {
  const requestId = requestIdFrom(request);
  const { status, code, errorCode, message, referenceId } = describeError(error);
  const level = status >= 500 ? "error" : "warn";
  logger[level]("api.error", {
    requestId,
    errorCode,
    status,
    result: "error",
    ...(error instanceof Error && status >= 500 ? { errorName: error.name } : {}),
  });
  const body: ApiErrorBody = {
    error: { code, errorCode, message: `${message}`, referenceId, requestId },
  };
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId } });
}

function describeError(error: unknown): {
  status: number;
  code: string;
  errorCode: ErrorCode;
  message: string;
  referenceId: string;
} {
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
    return {
      status: 429,
      code: "limit_reached",
      errorCode: "QUOTA_EXCEEDED",
      message:
        error.kind === "test_run"
          ? "Your Free plan automated test run limit has been reached."
          : "Your Free plan analysis limit has been reached.",
      referenceId: generateReferenceId(),
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
      return "conflict";
    default:
      return "internal";
  }
}

/** Adds the request id header to successful responses. */
export function withRequestId<T extends Response>(response: T, request?: NextRequest | Request): T {
  response.headers.set("x-request-id", requestIdFrom(request) || generateRequestId());
  return response;
}
