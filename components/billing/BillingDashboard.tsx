"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, CreditCard, ExternalLink, Receipt, RotateCcw, ShieldCheck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Progress } from "@/components/ui/Progress";
import { PlanCard } from "./PlanCard";
import { openRazorpayCheckout } from "./RazorpayCheckout";
import { describeState, formatDate, formatMoney, type ApiErrorPayload, type BillingStateView, type InvoiceView, type PlanId, type UsageBucket } from "./types";

interface Feedback {
  kind: "error" | "info" | "success";
  message: string;
  referenceId?: string;
}

async function readError(response: Response, fallback: string): Promise<Feedback> {
  const body = (await response.json().catch(() => null)) as ApiErrorPayload | null;
  return { kind: "error", message: body?.error?.message ?? fallback, referenceId: body?.error?.referenceId };
}

export function BillingDashboard() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<BillingStateView | null>(null);
  const [invoices, setInvoices] = useState<InvoiceView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"checkout" | "portal" | "cancel" | "reactivate" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/billing", { cache: "no-store" });
    if (!response.ok) {
      setFeedback(await readError(response, "Billing information could not be loaded."));
      setLoading(false);
      return;
    }
    const data = (await response.json()) as BillingStateView;
    setState(data);
    setLoading(false);
    if (data.enabled && data.provider?.invoices) {
      const inv = await fetch("/api/billing/invoices", { cache: "no-store" });
      if (inv.ok) setInvoices(((await inv.json()) as { invoices: InvoiceView[] }).invoices);
      else setInvoices([]);
    } else {
      setInvoices([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // `?plan=<id>` arrives from the public pricing page (via signup/login). It
  // only highlights the plan and scrolls to the section — checkout always
  // needs an explicit click, never a URL.
  const requestedPlan = searchParams.get("plan");
  const highlightedPlan: PlanId | null = requestedPlan === "pro" || requestedPlan === "business" ? requestedPlan : null;

  useEffect(() => {
    if (searchParams.get("checkout") === "cancelled") {
      setFeedback({ kind: "info", message: "Checkout was cancelled. Your plan has not changed." });
    }
  }, [searchParams]);

  useEffect(() => {
    if (!highlightedPlan || loading) return;
    document.getElementById("plans-heading")?.scrollIntoView({ block: "start" });
  }, [highlightedPlan, loading]);

  const startCheckout = useCallback(async (planId: PlanId) => {
    setBusy("checkout");
    setFeedback(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      if (!response.ok) {
        setFeedback(await readError(response, "Checkout could not be started."));
        return;
      }
      const data = (await response.json()) as { url: string; checkout?: { provider: "razorpay"; keyId: string; subscriptionId: string; planName: string; currency: string } };
      if (data.checkout?.provider === "razorpay") {
        const plan = state?.plans.find((entry) => entry.id === planId);
        const outcome = await openRazorpayCheckout({
          keyId: data.checkout.keyId,
          subscriptionId: data.checkout.subscriptionId,
          planName: plan?.name ?? data.checkout.planName,
          currency: data.checkout.currency,
        });
        if (outcome.kind === "script-error") {
          setFeedback({ kind: "error", message: "The secure payment window could not be opened. Check your connection and try again." });
          return;
        }
        if (outcome.kind === "dismissed") {
          setFeedback({ kind: "info", message: "Checkout was cancelled. Your plan has not changed." });
          return;
        }
        router.push(`/dashboard/billing/return?session_id=${encodeURIComponent(outcome.response.razorpay_subscription_id ?? data.checkout.subscriptionId)}&payment_id=${encodeURIComponent(outcome.response.razorpay_payment_id)}&signature=${encodeURIComponent(outcome.response.razorpay_signature)}`);
        return;
      }
      window.location.assign(data.url);
    } finally {
      setBusy(null);
    }
  }, [router, state]);

  const openPortal = useCallback(async () => {
    setBusy("portal");
    setFeedback(null);
    try {
      const response = await fetch("/api/billing/portal", { method: "POST" });
      if (!response.ok) {
        setFeedback(await readError(response, "The billing portal could not be opened."));
        return;
      }
      const { url } = (await response.json()) as { url: string };
      window.location.assign(url);
    } finally {
      setBusy(null);
    }
  }, []);

  const changeSubscription = useCallback(async (action: "cancel" | "reactivate") => {
    setBusy(action);
    setFeedback(null);
    try {
      const response = await fetch(`/api/billing/${action}`, { method: "POST" });
      if (!response.ok) {
        setFeedback(await readError(response, "The change could not be applied."));
        return;
      }
      const { billing } = (await response.json()) as { billing: BillingStateView };
      setState(billing);
      setFeedback({
        kind: "success",
        message: action === "cancel" ? "Your subscription will end at the close of the current period." : "Your subscription will continue to renew.",
      });
    } finally {
      setBusy(null);
      setConfirmCancel(false);
    }
  }, []);

  const status = useMemo(() => (state ? describeState(state.state, state.subscription) : null), [state]);

  if (loading || !state || !status) {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <Card><div className="h-24 animate-pulse rounded-xl bg-[var(--surface-secondary)]" /></Card>
        <Card><div className="h-32 animate-pulse rounded-xl bg-[var(--surface-secondary)]" /></Card>
        {feedback ? <FeedbackNotice feedback={feedback} /> : null}
      </div>
    );
  }

  const currentPlanId = state.plan.id;
  const subscribedPlan = state.subscription?.planId ?? null;
  const showPlans = !state.paid || state.state === "cancel_scheduled";

  return (
    <div className="space-y-6">
      {feedback ? <FeedbackNotice feedback={feedback} onDismiss={() => setFeedback(null)} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">Current plan</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-semibold tracking-tight">{state.plan.name}</h2>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {status.detail ?? state.plan.description}
              </p>
              {subscribedPlan && subscribedPlan !== currentPlanId ? (
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  Your {state.plans.find((p) => p.id === subscribedPlan)?.name ?? subscribedPlan} subscription is not active, so Free plan limits apply.
                </p>
              ) : null}
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold tabular-nums">{state.plan.price.formatted}</p>
              {state.plan.price.amount ? <p className="text-xs text-[var(--text-secondary)]">per month</p> : null}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {!state.enabled ? (
              <p className="text-sm text-[var(--text-secondary)]">Paid plans are not available on this deployment.</p>
            ) : null}
            {state.enabled && state.provider?.hostedPortal && state.subscription ? (
              <Button variant="secondary" size="sm" loading={busy === "portal"} disabled={busy !== null} onClick={() => void openPortal()}>
                <CreditCard className="h-4 w-4" aria-hidden="true" />
                Manage billing
              </Button>
            ) : null}
            {state.subscription?.canCancel ? (
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
                <XCircle className="h-4 w-4" aria-hidden="true" />
                Cancel subscription
              </Button>
            ) : null}
            {state.subscription?.canReactivate && state.provider?.reactivate ? (
              <Button variant="accent" size="sm" loading={busy === "reactivate"} disabled={busy !== null} onClick={() => void changeSubscription("reactivate")}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Keep my subscription
              </Button>
            ) : null}
            {(state.state === "past_due" || state.state === "past_due_grace") && state.provider?.hostedPortal ? (
              <Button variant="accent" size="sm" loading={busy === "portal"} disabled={busy !== null} onClick={() => void openPortal()}>
                Update payment method
              </Button>
            ) : null}
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />
            <h3 className="text-base font-semibold tracking-tight">Billing cycle</h3>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-secondary)]">{state.usage.period.source === "subscription" ? "Period started" : "Usage period"}</dt>
              <dd className="font-medium tabular-nums">{state.usage.period.source === "subscription" ? formatDate(state.usage.period.start) : "Calendar month"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-secondary)]">{state.state === "cancel_scheduled" ? "Ends" : state.paid ? "Renews" : "Usage resets"}</dt>
              <dd className="font-medium tabular-nums">{formatDate(state.state === "cancel_scheduled" ? state.subscription?.paidUntil : state.usage.period.end)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-secondary)]">Payment status</dt>
              <dd><Badge tone={status.tone}>{paymentLabel(state)}</Badge></dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">Usage this period</h3>
          <p className="text-xs text-[var(--text-secondary)]">Resets {formatDate(state.usage.analyses.resetAt)}</p>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <UsageBar label="Analyses" bucket={state.usage.analyses} />
          <UsageBar label="Automated test runs" bucket={state.usage.testRuns} />
          {state.usage.aiRequests && state.plan.features.aiEnabled ? <UsageBar label="AI assistance requests" bucket={state.usage.aiRequests} /> : null}
        </div>
        <p className="mt-4 text-xs text-[var(--text-secondary)]">
          Reserved units belong to runs that are queued or in progress. Invalid uploads never count; runs that fail before the browser starts are refunded automatically.
        </p>
      </Card>

      <section aria-labelledby="plans-heading">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h3 id="plans-heading" className="scroll-mt-24 text-base font-semibold tracking-tight">Plans</h3>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              {showPlans ? "Upgrade any time. Payments are handled by our payment provider; card details never touch ExtensionLab." : "Plan changes and payment details are managed through the billing portal."}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          {state.plans.map((plan) => {
            const isCurrent = plan.id === currentPlanId && (plan.id !== "free" || !state.paid);
            const canBuy = state.enabled && plan.purchasable && showPlans && plan.rank > (state.paid ? -1 : state.plan.rank) && plan.id !== subscribedPlan;
            return (
              <PlanCard
                key={plan.id}
                plan={plan}
                current={isCurrent}
                recommended={highlightedPlan ? plan.id === highlightedPlan && canBuy : plan.id === "pro" && !state.paid}
                action={
                  isCurrent
                    ? { label: "Current plan", disabled: true, variant: "secondary" }
                    : canBuy
                      ? { label: `Upgrade to ${plan.name}`, onClick: () => void startCheckout(plan.id), loading: busy === "checkout", disabled: busy !== null }
                      : plan.id !== "free" && !plan.purchasable
                        ? { label: "Not yet available", disabled: true, variant: "secondary" }
                        : undefined
                }
                footnote={plan.id !== "free" && plan.purchasable ? "Cancel any time. Billed monthly." : null}
              />
            );
          })}
        </div>
      </section>

      {state.payments && state.payments.length > 0 ? (
        <Card>
          <div className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />
            <h3 className="text-base font-semibold tracking-tight">Payment history</h3>
          </div>
          <ul className="mt-4 divide-y divide-[var(--border)]">
            {state.payments.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium">{state.plans.find((plan) => plan.id === payment.planId)?.name ?? payment.planId} plan</p>
                  <p className="text-xs text-[var(--text-secondary)]">{formatDate(payment.createdAt)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums">{formatMoney(payment.amount, payment.currency)}</span>
                  <Badge tone={payment.status === "paid" ? "success" : "error"}>{payment.status === "paid" ? "Paid" : "Failed"}</Badge>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--text-secondary)]">Card details are handled by the payment provider and never stored by ExtensionLab.</p>
        </Card>
      ) : null}

      {state.enabled && state.provider?.invoices ? (
        <Card>
          <div className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />
            <h3 className="text-base font-semibold tracking-tight">Invoices</h3>
          </div>
          {invoices === null ? (
            <div className="mt-4 h-10 animate-pulse rounded-xl bg-[var(--surface-secondary)]" />
          ) : invoices.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--text-secondary)]">No invoices yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--border)]">
              {invoices.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium tabular-nums">{formatDate(invoice.date)}</p>
                    {invoice.periodStart && invoice.periodEnd ? (
                      <p className="text-xs text-[var(--text-secondary)]">{formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums">{formatMoney(invoice.amount, invoice.currency)}</span>
                    <Badge tone={invoice.status === "paid" ? "success" : invoice.status === "open" ? "warning" : "neutral"}>{invoiceLabel(invoice.status)}</Badge>
                    {invoice.hostedUrl ? (
                      <a href={invoice.hostedUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-[var(--accent)]">
                        View <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <p className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Payments, cards and invoices are handled by our payment provider. ExtensionLab stores only your plan and subscription status. Downgrading or cancelling never deletes your projects, reports or history.
      </p>

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel your subscription?"
        description={`You keep ${state.plan.name} features until ${formatDate(state.subscription?.currentPeriodEnd)}. After that your workspace moves to the Free plan. Nothing is deleted.`}
      >
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => setConfirmCancel(false)} disabled={busy === "cancel"}>Keep subscription</Button>
          <Button variant="primary" loading={busy === "cancel"} onClick={() => void changeSubscription("cancel")}>Cancel at period end</Button>
        </div>
      </Modal>
    </div>
  );
}

function UsageBar({ label, bucket }: { label: string; bucket: UsageBucket }) {
  const consumed = bucket.used + bucket.reserved;
  const ratio = bucket.limit > 0 ? (consumed / bucket.limit) * 100 : 0;
  const tone = ratio >= 100 ? "error" : ratio >= 80 ? "warning" : "accent";
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-[var(--text-secondary)]">
          {bucket.used}{bucket.reserved > 0 ? ` (+${bucket.reserved} reserved)` : ""} / {bucket.limit}
        </span>
      </div>
      <Progress value={ratio} tone={tone} aria-label={`${label}: ${consumed} of ${bucket.limit} used`} showValue={false} />
    </div>
  );
}

function FeedbackNotice({ feedback, onDismiss }: { feedback: Feedback; onDismiss?: () => void }) {
  const tone =
    feedback.kind === "error"
      ? "border-[var(--status-error)] bg-[var(--status-error-soft)]"
      : feedback.kind === "success"
        ? "border-[var(--status-success)] bg-[var(--status-success-soft)]"
        : "border-[var(--border)] bg-[var(--surface-secondary)]";
  return (
    <div role={feedback.kind === "error" ? "alert" : "status"} className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${tone}`}>
      <div>
        <p>{feedback.message}</p>
        {feedback.referenceId ? <p className="mt-1 text-xs text-[var(--text-secondary)]">Reference: {feedback.referenceId}</p> : null}
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

function paymentLabel(state: BillingStateView): string {
  switch (state.state) {
    case "active":
    case "cancel_scheduled":
      return "Paid";
    case "trialing":
      return "Trial";
    case "past_due":
    case "past_due_grace":
      return "Payment failed";
    case "incomplete":
      return "Pending";
    default:
      return state.paid ? "Paid" : "No charges";
  }
}

function invoiceLabel(status: InvoiceView["status"]): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "open":
      return "Due";
    case "void":
      return "Void";
    case "uncollectible":
      return "Unpaid";
    default:
      return "Draft";
  }
}
