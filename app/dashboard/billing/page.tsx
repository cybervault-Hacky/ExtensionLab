import type { Metadata } from "next";
import { Suspense } from "react";
import { BillingDashboard } from "@/components/billing/BillingDashboard";

export const metadata: Metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

export default function BillingPage() {
  return (
    <div>
      <p className="eyebrow">Workspace</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Billing</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        Your plan, usage for the current billing period, payment status and invoices.
      </p>
      <div className="mt-6">
        <Suspense fallback={null}>
          <BillingDashboard />
        </Suspense>
      </div>
    </div>
  );
}
