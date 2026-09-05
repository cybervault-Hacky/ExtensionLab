import type { Metadata } from "next";
import { Suspense } from "react";
import { CheckoutReturn } from "@/components/billing/CheckoutReturn";

export const metadata: Metadata = { title: "Confirming payment" };
export const dynamic = "force-dynamic";

export default function CheckoutReturnPage() {
  return (
    <div>
      <p className="eyebrow">Billing</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Checkout</h1>
      <div className="mt-6">
        <Suspense fallback={null}>
          <CheckoutReturn />
        </Suspense>
      </div>
    </div>
  );
}
