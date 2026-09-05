/**
 * Billing domain types shared by the plan catalog, the entitlement service,
 * the provider adapters and the API projections.
 *
 * Nothing in this file depends on a payment provider. Provider-specific
 * objects are normalized into the `Provider*` shapes below inside the adapter
 * (`lib/billing/providers/*`) so the rest of the application only ever sees
 * these types.
 */

export const PLAN_IDS = ["free", "pro", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type BillingInterval = "month";

/** Boolean / policy features a plan grants (usage limits live next to them). */
export interface PlanFeatures {
  /** Report share links may be created. */
  sharingEnabled: boolean;
  /**
   * Longest share-link expiry the plan may choose, in hours. `0` means the
   * plan may create links that never expire.
   */
  shareMaxExpiryHours: number;
  /** Runtime evidence downloads (screenshots, runtime logs, network summaries). */
  advancedDiagnostics: boolean;
  /** Automated test jobs are queued ahead of standard jobs. */
  priorityExecution: boolean;
  /** Phase 8: AI assistance (explanations, summaries, suggestions) may be requested. */
  aiEnabled: boolean;
}

export interface PlanLimits {
  /** Analyses per billing period. */
  analysisLimit: number;
  /** Automated test runs per billing period. */
  testRunLimit: number;
  /** Phase 8: AI assistance requests per billing period (0 when AI is not included). */
  aiRequestLimit: number;
  /** Largest accepted extension package in bytes (never above the Phase 1 hard cap). */
  maxExtensionSize: number;
  /** Queued + running automated test runs at the same time. */
  maxConcurrentRuns: number;
  /** Minimum number of days test-run/report history is kept. */
  historyRetentionDays: number;
  /** Days runtime artifacts are kept after a run. */
  artifactRetentionDays: number;
  /** Days an unused stored package is kept. */
  packageRetentionDays: number;
}

export interface PlanPrice {
  /** Amount in the currency's minor unit (paise, cents); `null` when not configured. */
  amount: number | null;
  /** ISO 4217 lowercase currency code. */
  currency: string;
  interval: BillingInterval;
}

export interface Plan extends PlanLimits, PlanFeatures {
  id: PlanId;
  name: string;
  description: string;
  audience: string;
  price: PlanPrice;
  /** Paid plans are purchasable only when their provider price id is configured. */
  purchasable: boolean;
  /** Ordering / comparison rank: higher is a bigger plan. */
  rank: number;
  highlights: string[];
}

/** Normalized subscription statuses (a superset of what Stripe reports). */
export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

export const BILLING_PROVIDER_NAMES = ["stripe", "fake", "disabled"] as const;
export type BillingProviderName = (typeof BILLING_PROVIDER_NAMES)[number];

/** Provider-agnostic snapshot of a subscription as the provider reports it. */
export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  priceId: string | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: number | null;
  canceledAt: number | null;
  trialEnd: number | null;
  endedAt: number | null;
  /** Application metadata we attached at checkout (never trusted for plan resolution). */
  metadata: { userId?: string; planId?: string };
}

export type ProviderInvoiceStatus = "draft" | "open" | "paid" | "uncollectible" | "void";

export interface ProviderInvoice {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  status: ProviderInvoiceStatus;
  amountDue: number;
  amountPaid: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  createdAt: number;
}

export interface ProviderCheckoutSession {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  /** `complete` once the provider confirmed payment; never trusted for activation on its own. */
  status: "open" | "complete" | "expired";
  metadata: { userId?: string; planId?: string };
}

/** Internal event vocabulary. Provider event names are mapped onto these. */
export const BILLING_EVENT_TYPES = [
  "checkout.completed",
  "subscription.created",
  "subscription.updated",
  "subscription.deleted",
  "invoice.created",
  "invoice.paid",
  "invoice.payment_failed",
  "unknown",
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

export interface ProviderEvent {
  id: string;
  type: BillingEventType;
  /** Raw provider event name, for logs and the audit trail only. */
  providerType: string;
  createdAt: number;
  subscription?: ProviderSubscription;
  invoice?: ProviderInvoice;
  checkoutSession?: ProviderCheckoutSession;
  customerId?: string;
}

export interface ProviderCapabilities {
  hostedPortal: boolean;
  cancelAtPeriodEnd: boolean;
  reactivate: boolean;
  invoices: boolean;
}

export interface CreateCheckoutInput {
  userId: string;
  planId: PlanId;
  priceId: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  /** Provider idempotency key; repeated clicks return the same session. */
  idempotencyKey: string;
}

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

/**
 * The only interface the application talks to. Adapters translate these calls
 * into provider API requests; they must never leak provider errors, secrets or
 * raw payloads outside `lib/billing/providers`.
 */
export interface BillingProvider {
  readonly name: BillingProviderName;
  readonly capabilities: ProviderCapabilities;
  ensureCustomer(input: { userId: string; email: string; name: string }): Promise<{ customerId: string }>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSessionResult>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  getCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession | null>;
  getSubscription(subscriptionId: string): Promise<ProviderSubscription | null>;
  cancelSubscription(subscriptionId: string, options: { atPeriodEnd: boolean }): Promise<ProviderSubscription>;
  reactivateSubscription(subscriptionId: string): Promise<ProviderSubscription>;
  listInvoices(customerId: string, limit: number): Promise<ProviderInvoice[]>;
  /**
   * Verifies the webhook signature and parses the payload. Throws
   * `BillingError("WEBHOOK_SIGNATURE_INVALID")` for missing/invalid/stale
   * signatures and modified payloads.
   */
  verifyWebhook(rawBody: string, headers: Headers): ProviderEvent;
}

/** Derived, user-facing billing status (never a raw provider state). */
export type BillingStateKind =
  | "free"
  | "active"
  | "trialing"
  /** Payment failed; paid entitlements kept during the grace window. */
  | "past_due_grace"
  /** Payment failed and the grace window elapsed; Free entitlements apply. */
  | "past_due"
  | "cancel_scheduled"
  | "cancelled"
  | "expired"
  | "incomplete"
  | "paused";

export interface UsagePeriod {
  start: number;
  end: number;
  source: "calendar" | "subscription";
}

export interface QuotaUsage {
  used: number;
  reserved: number;
  limit: number;
  remaining: number;
  resetAt: number;
}
