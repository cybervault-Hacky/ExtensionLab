"use client";

import { useCallback, useRef, useState } from "react";
import { paywallFromError, type PaywallInfo } from "@/components/billing/PaywallNotice";
import type { ApiErrorPayload } from "@/components/billing/types";
import type { AIOutput, AIResponseEnvelope } from "./types";

/**
 * One on-demand AI request. Nothing runs on mount; the caller invokes `run`
 * from a button. Failures are classified into the states the UI renders:
 * paywall (plan/quota), unavailable (not configured / provider trouble),
 * rate limited, or a plain message. AI failures never affect the caller's
 * deterministic data.
 */

export type AIRequestState<T extends AIOutput> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: AIResponseEnvelope<T> }
  | { status: "paywall"; paywall: PaywallInfo }
  | { status: "unavailable"; message: string; referenceId?: string }
  | { status: "error"; message: string; referenceId?: string };

const UNAVAILABLE_CODES = new Set(["AI_NOT_CONFIGURED", "AI_UNAVAILABLE", "AI_PROVIDER_ERROR", "AI_TIMEOUT", "AI_INVALID_OUTPUT"]);

export function useAIRequest<T extends AIOutput>(path: string) {
  const [state, setState] = useState<AIRequestState<T>>({ status: "idle" });
  const inFlight = useRef(false);

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setState({ status: "loading" });
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (response.ok) {
          setState({ status: "success", data: (await response.json()) as AIResponseEnvelope<T> });
          return;
        }
        const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
        const paywall = paywallFromError(payload);
        if (paywall) {
          setState({ status: "paywall", paywall });
          return;
        }
        const code = payload?.error?.errorCode;
        const referenceId = payload?.error?.referenceId;
        if (code && UNAVAILABLE_CODES.has(code)) {
          setState({ status: "unavailable", message: payload?.error?.message ?? "AI analysis is temporarily unavailable.", referenceId });
          return;
        }
        if (code === "AI_QUOTA_EXCEEDED") {
          setState({ status: "paywall", paywall: { message: "AI usage limit reached.", referenceId, requiredPlanName: null } });
          return;
        }
        setState({ status: "error", message: payload?.error?.message ?? "The AI request could not be completed.", referenceId });
      } catch {
        setState({ status: "unavailable", message: "AI analysis is temporarily unavailable." });
      } finally {
        inFlight.current = false;
      }
    },
    [path],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset };
}
