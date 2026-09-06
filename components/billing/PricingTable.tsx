"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlanCard } from "./PlanCard";
import { openRazorpayCheckout } from "./RazorpayCheckout";
import type { ApiErrorPayload, PlanComparisonRow, PlanView } from "./types";

interface CheckoutApiResponse {
  url: string;
  reused: boolean;
  /** Present for popup providers (Razorpay): safe, public checkout configuration. */
  checkout?: { provider: "razorpay"; keyId: string; subscriptionId: string; planName: string; currency: string; amount: number | null };
}

interface PricingTableProps {
  plans: PlanView[];
  comparison: PlanComparisonRow[];
  billingEnabled: boolean;
  /** Whether the visitor is signed in (server-determined); decides the CTA target. */
  signedIn: boolean;
  currentPlanId: PlanView["id"] | null;
}

export function PricingTable({ plans, comparison, billingEnabled, signedIn, currentPlanId }: PricingTableProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<{ message: string; referenceId?: string } | null>(null);

  const choose = async (plan: PlanView) => {
    if (plan.id === "free") {
      router.push(signedIn ? "/dashboard" : "/signup");
      return;
    }
    if (!signedIn) {
      router.push(`/signup?next=${encodeURIComponent(`/dashboard/billing?plan=${plan.id}`)}`);
      return;
    }
    setBusy(plan.id);
    setError(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiErrorPayload | null;
        if (body?.error?.errorCode === "SUBSCRIPTION_STATE_INVALID") {
          router.push("/dashboard/billing");
          return;
        }
        setError({ message: body?.error?.message ?? "Checkout could not be started.", referenceId: body?.error?.referenceId });
        return;
      }
      const data = (await response.json()) as CheckoutApiResponse;
      if (data.checkout?.provider === "razorpay") {
        // Phase 14: popup checkout. The relayed confirmation is verified by
        // the server on the return flow; the browser trusts nothing.
        setOpening(true);
        const outcome = await openRazorpayCheckout({
          keyId: data.checkout.keyId,
          subscriptionId: data.checkout.subscriptionId,
          planName: plan.name,
          currency: data.checkout.currency,
        });
        setOpening(false);
        if (outcome.kind === "script-error") {
          setError({ message: "The secure payment window could not be opened. Check your connection and try again." });
          return;
        }
        if (outcome.kind === "dismissed") {
          router.push("/dashboard/billing?checkout=cancelled");
          return;
        }
        router.push(`/dashboard/billing/return?session_id=${encodeURIComponent(outcome.response.razorpay_subscription_id ?? data.checkout.subscriptionId)}&payment_id=${encodeURIComponent(outcome.response.razorpay_payment_id)}&signature=${encodeURIComponent(outcome.response.razorpay_signature)}`);
        return;
      }
      window.location.assign(data.url);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = signedIn && currentPlanId === plan.id;
          const purchasable = billingEnabled && plan.purchasable;
          return (
            <PlanCard
              key={plan.id}
              plan={plan}
              current={isCurrent}
              recommended={plan.id === "pro" && !isCurrent}
              action={
                isCurrent
                  ? { label: "Current plan", disabled: true, variant: "secondary" }
                  : plan.id === "free"
                    ? { label: signedIn ? "Go to dashboard" : "Start for free", onClick: () => void choose(plan), variant: "secondary" }
                    : purchasable
                      ? { label: signedIn ? `Buy ${plan.name}` : `Get ${plan.name}`, onClick: () => void choose(plan), loading: busy === plan.id || opening, disabled: busy !== null || opening }
                      : { label: "Not yet available", disabled: true, variant: "secondary" }
              }
              footnote={plan.id !== "free" && purchasable ? "Secure checkout via Razorpay. Billed monthly, cancel any time." : plan.id !== "free" ? "Self-serve checkout is not configured on this deployment." : null}
            />
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-[var(--status-error)]">
          {error.message}
          {error.referenceId ? <span className="block text-xs text-[var(--text-secondary)]">Reference: {error.referenceId}</span> : null}
        </p>
      ) : null}

      <div className="mt-14 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <caption className="sr-only">Plan comparison</caption>
          <thead>
            <tr className="border-b border-[var(--border)] text-left">
              <th scope="col" className="py-3 pr-4 font-semibold">What&apos;s included</th>
              {plans.map((plan) => (
                <th key={plan.id} scope="col" className="py-3 px-4 font-semibold">{plan.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.map((row) => (
              <tr key={row.key} className="border-b border-[var(--border)]">
                <th scope="row" className="py-3 pr-4 text-left font-medium text-[var(--text-secondary)]">{row.label}</th>
                {plans.map((plan) => (
                  <td key={plan.id} className="py-3 px-4 tabular-nums">{row.values[plan.id]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
