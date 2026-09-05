import "server-only";
import { getConfig } from "@/lib/config/env";
import { AppError } from "@/lib/observability/errors";
import { recordAuditEvent } from "@/lib/audit/service";
import {
  countWebhooks,
  deleteWebhookRow,
  getWebhookById,
  insertWebhookRow,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhookRow,
} from "@/lib/organizations/repository";
import { canUseOrgFeature } from "@/lib/organizations/entitlements";
import { generateWebhookSecret } from "./signing";
import { isWebhookEventType, type WebhookEventType } from "./dispatch";
import { validateWebhookDestination } from "./destination";

/** Customer webhook management (Phase 10). Secrets are shown exactly once. */

export interface WebhookView {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: number;
  lastDeliveryAt: number | null;
}

export interface CreatedWebhook extends WebhookView {
  /** Signing secret, shown exactly once at creation. */
  secret: string;
}

function toView(row: { id: string; url: string; events_json: string; active: number; created_at: number }): WebhookView {
  let events: string[] = [];
  try {
    events = JSON.parse(row.events_json) as string[];
  } catch {
    events = [];
  }
  return { id: row.id, url: row.url, events, active: row.active === 1, createdAt: row.created_at, lastDeliveryAt: null };
}

function parseEvents(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new AppError("INVALID_INPUT", { message: "events must be an array of event types." });
  if (raw.length === 0 || raw.length > 20) throw new AppError("INVALID_INPUT", { message: "Select between 1 and 20 event types." });
  const events: string[] = [];
  for (const entry of raw) {
    if (entry === "*") {
      events.push("*");
      continue;
    }
    if (!isWebhookEventType(entry)) throw new AppError("INVALID_INPUT", { message: `Unknown event type: ${String(entry).slice(0, 40)}` });
    events.push(entry);
  }
  return events;
}

export async function createWebhook(ctx: { userId: string; organizationId: string; requestId?: string | null; ip?: string | null }, input: { url: string; events: unknown }): Promise<CreatedWebhook> {
  const entitlement = canUseOrgFeature(ctx.organizationId, "webhooks");
  if (!entitlement.allowed) throw new AppError("PAYMENT_REQUIRED", { message: entitlement.message });
  if (countWebhooks(ctx.organizationId) >= getConfig().organizations.maxWebhooksPerOrg) {
    throw new AppError("CONFLICT", { message: "This organization has reached its webhook limit." });
  }
  const events = parseEvents(input.events);
  const verdict = await validateWebhookDestination(input.url);
  if (!verdict.ok || !verdict.url) {
    throw new AppError("WEBHOOK_DESTINATION_BLOCKED", { message: verdict.reason ?? "This webhook destination is not allowed." });
  }
  const secret = generateWebhookSecret();
  const row = insertWebhookRow({ organizationId: ctx.organizationId, url: verdict.url, secret, events, createdBy: ctx.userId });
  recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "webhook.created", resourceType: "webhook", resourceId: row.id, requestId: ctx.requestId, ip: ctx.ip, metadata: { events: events.join(",") } });
  return { ...toView(row), secret };
}

export async function updateWebhook(ctx: { userId: string; organizationId: string; requestId?: string | null; ip?: string | null }, webhookId: string, input: { url?: string; events?: unknown; active?: boolean }): Promise<WebhookView> {
  const row = getWebhookById(ctx.organizationId, webhookId);
  if (!row) throw new AppError("NOT_FOUND", { message: "Webhook not found." });
  let url = row.url;
  if (input.url !== undefined) {
    const verdict = await validateWebhookDestination(input.url);
    if (!verdict.ok || !verdict.url) {
      throw new AppError("WEBHOOK_DESTINATION_BLOCKED", { message: verdict.reason ?? "This webhook destination is not allowed." });
    }
    url = verdict.url;
  }
  const events = input.events !== undefined ? parseEvents(input.events) : JSON.parse(row.events_json) as string[];
  const active = input.active !== undefined ? (input.active ? 1 : 0) : row.active;
  updateWebhookRow(ctx.organizationId, webhookId, { url, events_json: JSON.stringify(events), active });
  recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "webhook.updated", resourceType: "webhook", resourceId: webhookId, requestId: ctx.requestId, ip: ctx.ip, metadata: { active: active === 1 ? "true" : "false" } });
  return toView(getWebhookById(ctx.organizationId, webhookId)!);
}

export function deleteWebhook(ctx: { userId: string; organizationId: string; requestId?: string | null; ip?: string | null }, webhookId: string): void {
  const row = getWebhookById(ctx.organizationId, webhookId);
  if (!row) throw new AppError("NOT_FOUND", { message: "Webhook not found." });
  deleteWebhookRow(ctx.organizationId, webhookId);
  recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "webhook.deleted", resourceType: "webhook", resourceId: webhookId, requestId: ctx.requestId, ip: ctx.ip });
}

export function listOrganizationWebhooks(organizationId: string): WebhookView[] {
  return listWebhooks(organizationId).map(toView);
}

/** Secrets are never returned after creation. */
export function listWebhookDeliveriesForOrg(organizationId: string, webhookId: string | null, page: number, limit: number) {
  const boundedLimit = Math.min(Math.max(1, limit), 100);
  const offset = (Math.max(1, page) - 1) * boundedLimit;
  const rows = listWebhookDeliveries({ organizationId, ...(webhookId ? { webhookId } : {}), limit: boundedLimit, offset });
  return rows.map((row) => ({
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    status: row.status,
    attempts: row.attempts,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
  }));
}

export type { WebhookEventType };
