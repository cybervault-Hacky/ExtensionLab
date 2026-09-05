import { BillingError } from "../errors";
import type {
  BillingEventType,
  ProviderCheckoutSession,
  ProviderEvent,
  ProviderInvoice,
  ProviderInvoiceStatus,
  ProviderSubscription,
  SubscriptionStatus,
} from "../types";
import { isSubscriptionStatus } from "../types";

/**
 * Pure normalizers from Stripe's object shapes to the provider-agnostic
 * billing types. Kept free of I/O and `server-only` so the fake provider and
 * unit tests can share them with the real adapter.
 */

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function secondsToMs(value: unknown): number | null {
  const seconds = asNumber(value);
  return seconds === null ? null : seconds * 1000;
}

/** Stripe expands objects inline or returns their id; accept both. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  const record = asRecord(value);
  return record ? asString(record.id) : null;
}

export function encodeForm(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  return search.toString();
}

function normalizeStatus(value: unknown): SubscriptionStatus {
  return isSubscriptionStatus(value) ? value : "incomplete";
}

function normalizeMetadata(value: unknown): { userId?: string; planId?: string } {
  const record = asRecord(value) ?? {};
  const out: { userId?: string; planId?: string } = {};
  const userId = asString(record.userId ?? record.user_id);
  const planId = asString(record.planId ?? record.plan_id);
  if (userId) out.userId = userId;
  if (planId) out.planId = planId;
  return out;
}

export function normalizeStripeSubscription(raw: Json): ProviderSubscription {
  const items = asRecord(raw.items);
  const data = Array.isArray(items?.data) ? (items!.data as unknown[]) : [];
  const firstItem = asRecord(data[0]);
  const price = asRecord(firstItem?.price);
  // API 2025+ moved period fields onto the item; older versions keep them on the subscription.
  const periodStart = secondsToMs(raw.current_period_start) ?? secondsToMs(firstItem?.current_period_start);
  const periodEnd = secondsToMs(raw.current_period_end) ?? secondsToMs(firstItem?.current_period_end);
  return {
    id: asString(raw.id) ?? "",
    customerId: idOf(raw.customer) ?? "",
    status: normalizeStatus(raw.status),
    priceId: asString(price?.id) ?? idOf(firstItem?.price),
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: raw.cancel_at_period_end === true,
    cancelAt: secondsToMs(raw.cancel_at),
    canceledAt: secondsToMs(raw.canceled_at),
    trialEnd: secondsToMs(raw.trial_end),
    endedAt: secondsToMs(raw.ended_at),
    metadata: normalizeMetadata(raw.metadata),
  };
}

function normalizeInvoiceStatus(value: unknown): ProviderInvoiceStatus {
  return value === "draft" || value === "open" || value === "paid" || value === "uncollectible" || value === "void" ? value : "open";
}

export function normalizeStripeInvoice(raw: Json): ProviderInvoice {
  // Newer API versions expose the subscription under `parent.subscription_details`.
  const parent = asRecord(raw.parent);
  const subscriptionDetails = asRecord(parent?.subscription_details);
  return {
    id: asString(raw.id) ?? "",
    customerId: idOf(raw.customer) ?? "",
    subscriptionId: idOf(raw.subscription) ?? idOf(subscriptionDetails?.subscription),
    status: normalizeInvoiceStatus(raw.status),
    amountDue: asNumber(raw.amount_due) ?? 0,
    amountPaid: asNumber(raw.amount_paid) ?? 0,
    currency: (asString(raw.currency) ?? "").toLowerCase(),
    hostedInvoiceUrl: asString(raw.hosted_invoice_url),
    periodStart: secondsToMs(raw.period_start),
    periodEnd: secondsToMs(raw.period_end),
    createdAt: secondsToMs(raw.created) ?? Date.now(),
  };
}

export function normalizeStripeCheckoutSession(raw: Json): ProviderCheckoutSession {
  const status = raw.status === "complete" || raw.status === "expired" ? raw.status : "open";
  return {
    id: asString(raw.id) ?? "",
    customerId: idOf(raw.customer),
    subscriptionId: idOf(raw.subscription),
    status,
    metadata: normalizeMetadata(raw.metadata),
  };
}

/** Stripe event names → internal vocabulary. Unlisted events are acknowledged and ignored. */
const EVENT_MAP: Record<string, BillingEventType> = {
  "checkout.session.completed": "checkout.completed",
  "customer.subscription.created": "subscription.created",
  "customer.subscription.updated": "subscription.updated",
  "customer.subscription.deleted": "subscription.deleted",
  "customer.subscription.paused": "subscription.updated",
  "customer.subscription.resumed": "subscription.updated",
  "customer.subscription.trial_will_end": "subscription.updated",
  "invoice.created": "invoice.created",
  "invoice.paid": "invoice.paid",
  "invoice.payment_succeeded": "invoice.paid",
  "invoice.payment_failed": "invoice.payment_failed",
};

export function normalizeStripeEvent(raw: Json): ProviderEvent {
  const providerType = asString(raw.type) ?? "unknown";
  const type = EVENT_MAP[providerType] ?? "unknown";
  const data = asRecord(raw.data);
  const object = asRecord(data?.object) ?? {};
  const event: ProviderEvent = {
    id: asString(raw.id) ?? "",
    type,
    providerType,
    createdAt: secondsToMs(raw.created) ?? Date.now(),
  };
  if (!event.id) throw new BillingError("WEBHOOK_SIGNATURE_INVALID", { message: "The webhook payload is malformed." });
  const objectType = asString(object.object);
  if (objectType === "subscription") {
    event.subscription = normalizeStripeSubscription(object);
    event.customerId = event.subscription.customerId || undefined;
  } else if (objectType === "invoice") {
    event.invoice = normalizeStripeInvoice(object);
    event.customerId = event.invoice.customerId || undefined;
  } else if (objectType === "checkout.session") {
    event.checkoutSession = normalizeStripeCheckoutSession(object);
    event.customerId = event.checkoutSession.customerId ?? undefined;
  }
  return event;
}
