import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getApiUser } from "./session";
import { isSameOrigin } from "./csrf";
import type { UserRecord } from "@/lib/db/repositories/users";
import { generateReferenceId } from "@/lib/runtime/ids";

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

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, referenceId: error.referenceId } },
      { status: error.status },
    );
  }
  const referenceId = generateReferenceId();
  return NextResponse.json(
    { error: { code: "internal", message: "The request could not be completed.", referenceId } },
    { status: 500 },
  );
}
