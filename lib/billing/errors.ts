import { AppError, type ErrorCode } from "@/lib/observability/errors";

export type BillingErrorCode = Extract<
  ErrorCode,
  | "BILLING_NOT_CONFIGURED"
  | "BILLING_PROVIDER_ERROR"
  | "BILLING_PROVIDER_UNAVAILABLE"
  | "BILLING_CONFIGURATION_ERROR"
  | "PAYMENT_VERIFICATION_FAILED"
  | "PAYMENT_MISMATCH"
  | "DUPLICATE_PAYMENT"
  | "CHECKOUT_CREATION_FAILED"
  | "INVALID_PLAN"
  | "SUBSCRIPTION_NOT_FOUND"
  | "SUBSCRIPTION_STATE_INVALID"
  | "WEBHOOK_SIGNATURE_INVALID"
  | "PAYMENT_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
>;

/**
 * Billing errors are ordinary AppErrors from the Phase 6 catalog so the API
 * layer maps them to safe HTTP responses (`{ error: { errorCode, message,
 * referenceId } }`) without any provider detail. `cause` is kept for logs
 * only and is redacted by the logger.
 */
export class BillingError extends AppError {
  constructor(code: BillingErrorCode, options: { message?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(code, options);
    this.name = "BillingError";
  }
}

export function isBillingError(error: unknown): error is BillingError {
  return error instanceof BillingError;
}
