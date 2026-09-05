import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { PricingTable } from "@/components/billing/PricingTable";
import { getPlanCatalog, toPlanView } from "@/lib/billing/config";
import { getEffectivePlan } from "@/lib/billing/entitlements";
import { formatPlanAmount, orderedPlans, planComparisonRows } from "@/lib/billing/plans";
import { isBillingEnabled } from "@/lib/billing/provider";
import { restoreUser, SESSION_COOKIE } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Simple monthly plans for inspecting and testing browser extensions. Start free, upgrade when you need more runs, longer history and richer evidence.",
  alternates: { canonical: "/pricing" },
  openGraph: { title: "ExtensionLab pricing", description: "Free, Pro and Business plans for browser extension testing.", type: "website" },
};
export const dynamic = "force-dynamic";

const faqs = [
  { q: "What counts as an analysis or a test run?", a: "An analysis is one uploaded package inspected and saved to your workspace. A test run is one automated run in the isolated browser. Invalid uploads never count, and runs that fail before the browser starts are refunded automatically." },
  { q: "When do limits reset?", a: "On the Free plan limits reset at the start of each calendar month. On paid plans they reset at the start of each billing period." },
  { q: "Can I cancel?", a: "Yes, any time from the billing page. You keep paid features until the end of the period you have paid for; afterwards your workspace returns to the Free plan and nothing is deleted." },
  { q: "How are payments handled?", a: "Checkout, cards and invoices are handled by our payment provider. ExtensionLab never sees or stores card details. Prices are shown before tax; applicable taxes are calculated at checkout." },
  { q: "Do you offer refunds?", a: "Refund requests are handled case by case through support and processed by the payment provider." },
];

export default async function PricingPage() {
  const catalog = getPlanCatalog();
  const plans = orderedPlans(catalog).map((plan) => toPlanView(plan, formatPlanAmount(plan)));
  const comparison = planComparisonRows(catalog);
  const cookieStore = await cookies();
  const user = restoreUser(cookieStore.get(SESSION_COOKIE)?.value ?? "");
  const currentPlanId = user ? getEffectivePlan(user.id).plan.id : null;

  return (
    <div className="min-h-screen">
      <Navbar />
      <main>
        <section className="py-16 lg:py-24">
          <div className="section-width">
            <div className="mx-auto max-w-2xl text-center">
              <p className="eyebrow">Pricing</p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Start free. Upgrade when you ship more.</h1>
              <p className="mt-4 text-[var(--text-secondary)]">
                Every plan includes static analysis, automated tests in an isolated browser and shareable reports. Paid plans add more runs, longer history and richer runtime evidence.
              </p>
            </div>
            <div className="pt-12">
              <PricingTable plans={plans} comparison={comparison} billingEnabled={isBillingEnabled()} signedIn={Boolean(user)} currentPlanId={currentPlanId} />
            </div>
          </div>
        </section>
        <section className="bg-[var(--surface)] py-16">
          <div className="section-width">
            <div className="mx-auto max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight">Questions</h2>
              <dl className="mt-6 space-y-6">
                {faqs.map((item) => (
                  <div key={item.q}>
                    <dt className="font-medium">{item.q}</dt>
                    <dd className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{item.a}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
