"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlanCard } from "./PlanCard";
import type { ApiErrorPayload, PlanComparisonRow, PlanView } from "./types";

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
      const { url } = (await response.json()) as { url: string };
      window.location.assign(url);
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
                      ? { label: signedIn ? `Upgrade to ${plan.name}` : `Get ${plan.name}`, onClick: () => void choose(plan), loading: busy === plan.id, disabled: busy !== null }
                      : { label: "Contact us", href: "mailto:hello@extensionlab.dev", variant: "secondary" }
              }
              footnote={plan.id !== "free" && purchasable ? "Billed monthly. Cancel any time." : plan.id !== "free" ? "Not yet available for self-serve checkout." : null}
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
