/** Client-side mirrors of the server billing projections (no secrets, no provider ids). */

export type PlanId = "free" | "pro" | "business";

export type BillingStateKind =
  | "free"
  | "active"
  | "trialing"
  | "cancel_scheduled"
  | "past_due_grace"
  | "past_due"
  | "cancelled"
  | "expired"
  | "incomplete"
  | "paused";

export interface PlanView {
  id: PlanId;
  name: string;
  description: string;
  audience: string;
  price: { amount: number | null; currency: string; interval: "month"; formatted: string };
  purchasable: boolean;
  rank: number;
  highlights: string[];
  limits: {
    analysisLimit: number;
    testRunLimit: number;
    maxExtensionSize: number;
    maxConcurrentRuns: number;
    historyRetentionDays: number;
    artifactRetentionDays: number;
    packageRetentionDays: number;
    aiRequestLimit: number;
  };
  features: {
    sharingEnabled: boolean;
    shareMaxExpiryHours: number;
    advancedDiagnostics: boolean;
    priorityExecution: boolean;
    aiEnabled: boolean;
  };
}

export interface UsageBucket {
  used: number;
  reserved: number;
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface BillingStateView {
  enabled: boolean;
  provider: { hostedPortal: boolean; invoices: boolean; reactivate: boolean } | null;
  plan: PlanView;
  state: BillingStateKind;
  paid: boolean;
  subscription: {
    planId: PlanId;
    status: BillingStateKind;
    currentPeriodStart: number | null;
    currentPeriodEnd: number | null;
    cancelAtPeriodEnd: boolean;
    paidUntil: number | null;
    graceUntil: number | null;
    trialEnd: number | null;
    canCancel: boolean;
    canReactivate: boolean;
  } | null;
  usage: {
    period: { start: number; end: number; source: "calendar" | "subscription" };
    analyses: UsageBucket;
    testRuns: UsageBucket;
    aiRequests?: UsageBucket;
  };
  plans: PlanView[];
}

export interface InvoiceView {
  id: string;
  date: number;
  amount: number;
  currency: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  hostedUrl: string | null;
  periodStart: number | null;
  periodEnd: number | null;
}

export interface PlanComparisonRow {
  key: string;
  label: string;
  values: Record<PlanId, string>;
}

export interface ApiErrorPayload {
  error?: {
    code?: string;
    errorCode?: string;
    message?: string;
    referenceId?: string;
    requestId?: string;
    details?: {
      reason: "quota" | "plan" | "size";
      kind?: "analysis" | "test_run" | "ai_request";
      currentUsage?: number;
      limit?: number;
      resetAt?: number;
      plan: PlanId;
      requiredPlan: PlanId | null;
      requiredPlanName: string | null;
    };
  };
}

export function formatDate(value: number | null | undefined, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

export function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 2 }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function describeState(state: BillingStateKind, subscription: BillingStateView["subscription"]): { label: string; tone: "success" | "warning" | "error" | "neutral" | "info"; detail: string | null } {
  switch (state) {
    case "active":
      return { label: "Active", tone: "success", detail: subscription?.currentPeriodEnd ? `Renews ${formatDate(subscription.currentPeriodEnd)}` : null };
    case "trialing":
      return { label: "Trial", tone: "info", detail: subscription?.trialEnd ? `Trial ends ${formatDate(subscription.trialEnd)}` : null };
    case "cancel_scheduled":
      return { label: `Cancels on ${formatDate(subscription?.paidUntil)}`, tone: "warning", detail: "You keep paid features until then." };
    case "past_due_grace":
      return { label: "Payment issue", tone: "warning", detail: subscription?.graceUntil ? `Update your payment method before ${formatDate(subscription.graceUntil)} to keep paid features.` : "Update your payment method to keep paid features." };
    case "past_due":
      return { label: "Payment issue", tone: "error", detail: "Paid features are paused until payment succeeds." };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", detail: "Your workspace is on the Free plan. Your data is kept." };
    case "expired":
      return { label: "Expired", tone: "neutral", detail: "The subscription ended. Your data is kept." };
    case "incomplete":
      return { label: "Awaiting payment", tone: "warning", detail: "The first payment has not completed yet." };
    case "paused":
      return { label: "Paused", tone: "neutral", detail: "Paid features are paused." };
    case "free":
    default:
      return { label: "Free plan", tone: "neutral", detail: null };
  }
}
