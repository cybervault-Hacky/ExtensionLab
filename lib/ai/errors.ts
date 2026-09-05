import { AppError, type ErrorCode } from "@/lib/observability/errors";

export type AIErrorCode = Extract<
  ErrorCode,
  | "AI_NOT_CONFIGURED"
  | "AI_UNAVAILABLE"
  | "AI_PROVIDER_ERROR"
  | "AI_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_INVALID_OUTPUT"
  | "AI_CONTEXT_TOO_LARGE"
  | "AI_UNAUTHORIZED_CONTEXT"
  | "INVALID_INPUT"
>;

/**
 * AI errors are ordinary AppErrors from the stable catalog, so the API layer
 * maps them to safe responses without provider detail. `cause` is for logs
 * only (the logger redacts it) and never reaches clients.
 */
export class AIError extends AppError {
  constructor(code: AIErrorCode, options: { message?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(code, options);
    this.name = "AIError";
  }
}

export function isAIError(error: unknown): error is AIError {
  return error instanceof AIError;
}
