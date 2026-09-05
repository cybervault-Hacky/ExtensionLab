"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import type { ApiErrorPayload } from "./types";

export interface PaywallInfo {
  message: string;
  referenceId?: string;
  requiredPlanName: string | null;
  resetAt?: number;
  currentUsage?: number;
  limit?: number;
}

/**
 * Reads a failed API response and returns paywall details when the failure is
 * a plan/quota limit (QUOTA_EXCEEDED / PAYMENT_REQUIRED); otherwise null so the
 * caller can show its ordinary error message.
 */
export function paywallFromError(body: ApiErrorPayload | null): PaywallInfo | null {
  const error = body?.error;
  if (!error || !error.details) return null;
  if (error.errorCode !== "QUOTA_EXCEEDED" && error.errorCode !== "PAYMENT_REQUIRED" && error.errorCode !== "AI_QUOTA_EXCEEDED") return null;
  return {
    message: error.message ?? "Your plan limit has been reached.",
    referenceId: error.referenceId,
    requiredPlanName: error.details.requiredPlanName,
    resetAt: error.details.resetAt,
    currentUsage: error.details.currentUsage,
    limit: error.details.limit,
  };
}

export function PaywallNotice({ info, className }: { info: PaywallInfo; className?: string }) {
  const reset = info.resetAt ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(info.resetAt)) : null;
  return (
    <div role="status" className={`rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-4 text-sm ${className ?? ""}`}>
      <div className="flex items-start gap-3">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{info.message}</p>
          <p className="mt-1 text-[var(--text-secondary)]">
            {typeof info.currentUsage === "number" && typeof info.limit === "number" ? `${Math.min(info.currentUsage, info.limit)} of ${info.limit} used. ` : ""}
            {reset ? `Your limit resets on ${reset}.` : ""}
            {info.requiredPlanName ? ` ${info.requiredPlanName} includes more.` : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Link href="/dashboard/billing" className="font-medium text-[var(--accent)]">
              View plans
            </Link>
            {info.referenceId ? <span className="text-xs text-[var(--text-secondary)]">Reference: {info.referenceId}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
