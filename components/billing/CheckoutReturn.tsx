"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { ApiErrorPayload, BillingStateView } from "./types";

type Phase = "checking" | "complete" | "pending" | "expired" | "unknown" | "error";

const POLL_MS = 2500;
const MAX_POLLS = 24; // ~1 minute

/**
 * Post-checkout page. It never trusts the URL: the server confirms the session
 * it created for this user with the provider, and paid features appear only
 * once the subscription state is recorded (webhook or confirmation).
 */
export function CheckoutReturn() {
  const params = useSearchParams();
  const sessionId = params.get("session_id");
  const [phase, setPhase] = useState<Phase>("checking");
  const [plan, setPlan] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const polls = useRef(0);

  useEffect(() => {
    if (!sessionId) {
      setPhase("unknown");
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      polls.current += 1;
      try {
        const response = await fetch("/api/billing/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        if (cancelled) return;
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as ApiErrorPayload | null;
          setReference(body?.error?.referenceId ?? null);
          setPhase("error");
          return;
        }
        const data = (await response.json()) as { status: "pending" | "complete" | "expired" | "unknown"; billing: BillingStateView };
        setPlan(data.billing.plan.name);
        if (data.status === "complete") {
          setPhase("complete");
          return;
        }
        if (data.status === "expired" || data.status === "unknown") {
          setPhase(data.status);
          return;
        }
        setPhase("pending");
        if (polls.current < MAX_POLLS) timer = setTimeout(() => void tick(), POLL_MS);
      } catch {
        if (!cancelled) setPhase("error");
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  const timedOut = phase === "pending" && polls.current >= MAX_POLLS;

  return (
    <Card className="mx-auto max-w-xl">
      <div role="status" aria-live="polite">
        {phase === "checking" || (phase === "pending" && !timedOut) ? (
          <>
            <Clock className="h-8 w-8 text-[var(--accent)]" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-semibold tracking-tight">Your payment is being confirmed</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              This usually takes a few seconds. Paid features unlock automatically as soon as the payment provider confirms the subscription.
            </p>
          </>
        ) : null}
        {phase === "complete" ? (
          <>
            <CheckCircle2 className="h-8 w-8 text-[var(--status-success)]" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-semibold tracking-tight">You&apos;re on {plan ?? "your new plan"}</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Your new limits apply immediately. Thank you for supporting ExtensionLab.</p>
          </>
        ) : null}
        {timedOut ? (
          <>
            <Clock className="h-8 w-8 text-[var(--status-warning)]" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-semibold tracking-tight">Still confirming</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              The payment provider has not confirmed yet. Your plan updates automatically when it does — check the billing page in a minute. If you were charged and nothing changes, contact support with the reference below.
            </p>
          </>
        ) : null}
        {phase === "expired" ? (
          <>
            <AlertTriangle className="h-8 w-8 text-[var(--status-warning)]" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-semibold tracking-tight">This checkout expired</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">No payment was taken. You can start again from the billing page.</p>
          </>
        ) : null}
        {phase === "unknown" ? (
          <>
            <AlertTriangle className="h-8 w-8 text-[var(--status-warning)]" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-semibold tracking-tight">We couldn&apos;t find this checkout</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">The link may be incomplete or belong to another account. Your current plan is shown on the billing page.</p>
          </>
        ) : null}
        {phase === "error" ? (
          <>
            <AlertTriangle className="h-8 w-8 text-[var(--status-error)]" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-semibold tracking-tight">Something went wrong while confirming</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Your payment, if any, is safe with the provider. Reload this page or check the billing page.</p>
            {reference ? <p className="mt-2 text-xs text-[var(--text-secondary)]">Reference: {reference}</p> : null}
          </>
        ) : null}
        {sessionId && phase !== "complete" ? <p className="mt-4 text-xs text-[var(--text-secondary)]">Checkout reference: {sessionId.slice(0, 18)}…</p> : null}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button href="/dashboard/billing" variant={phase === "complete" ? "secondary" : "accent"} size="sm">Go to billing</Button>
        <Button href="/dashboard" variant={phase === "complete" ? "accent" : "secondary"} size="sm">Back to dashboard</Button>
      </div>
    </Card>
  );
}
