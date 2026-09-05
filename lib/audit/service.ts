import "server-only";
import { randomBytes } from "node:crypto";
import { insertAuditEventRow, queryAuditEvents, type AuditQuery } from "@/lib/organizations/repository";
import { redactSensitiveText } from "@/lib/runtime/redact";
import { logger } from "@/lib/observability/logger";
import type { OrganizationAuditEventRow } from "@/lib/db/schema/types";

/**
 * Organization audit trail (Phase 10).
 *
 * Audit events are immutable (insert-only). Metadata is minimized and
 * redacted before storage: no passwords, API keys, webhook secrets, session
 * tokens, cookies, authorization headers or uploaded source ever land here.
 * Values are bounded and key-filtered rather than passed through blindly.
 */

const MAX_METADATA_KEYS = 12;
const MAX_VALUE_LENGTH = 300;
const ALLOWED_KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;
const BLOCKED_KEY_PATTERN = /password|secret|token|cookie|authorization|api[-_]?key|header|body|payload|source/i;

export interface AuditEventInput {
  organizationId: string;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  success?: boolean;
  metadata?: Record<string, unknown>;
}

/** Bounded, redacted, key-filtered metadata projection. */
export function sanitizeAuditMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  if (!metadata || typeof metadata !== "object") return safe;
  for (const [key, value] of Object.entries(metadata).slice(0, MAX_METADATA_KEYS)) {
    if (!ALLOWED_KEY_PATTERN.test(key) || BLOCKED_KEY_PATTERN.test(key)) continue;
    if (value === null || value === undefined) {
      safe[key] = "null";
      continue;
    }
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    safe[key] = redactSensitiveText(text).slice(0, MAX_VALUE_LENGTH);
  }
  return safe;
}

export function recordAuditEvent(input: AuditEventInput): void {
  try {
    insertAuditEventRow({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? null,
      actorApiKeyId: input.actorApiKeyId ?? null,
      action: input.action.slice(0, 64),
      resourceType: input.resourceType?.slice(0, 64) ?? null,
      resourceId: input.resourceId?.slice(0, 128) ?? null,
      requestId: input.requestId?.slice(0, 64) ?? null,
      ip: input.ip?.slice(0, 64) ?? null,
      success: input.success ?? true,
      metadataJson: JSON.stringify(sanitizeAuditMetadata(input.metadata)),
    });
  } catch (error) {
    // Auditing must never break the operation it describes; log internally.
    logger.warn("audit.write_failed", { organizationId: input.organizationId, action: input.action, errorCode: (error as { code?: string }).code ?? "INTERNAL" });
  }
}

/** Masked actor identity for audit UI (email domain only for API-key actors is not stored anyway). */
export interface AuditEventView {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string | null;
  success: boolean;
  metadata: Record<string, string>;
  createdAt: number;
  actorUserId: string | null;
  actorApiKeyId: string | null;
}

export function toAuditEventView(row: OrganizationAuditEventRow): AuditEventView {
  let metadata: Record<string, string> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as Record<string, string>;
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestId: row.request_id,
    success: row.success === 1,
    metadata,
    createdAt: row.created_at,
    actorUserId: row.actor_user_id,
    actorApiKeyId: row.actor_api_key_id,
  };
}

export function queryAuditEventsForOrg(query: Omit<AuditQuery, "organizationId"> & { organizationId: string }): { items: AuditEventView[]; total: number } {
  const result = queryAuditEvents(query);
  return { items: result.items.map(toAuditEventView), total: result.total };
}

/** Stable list of audited actions (UI filter dropdown; extensible). */
export const AUDIT_ACTIONS = [
  "org.created",
  "org.updated",
  "org.deleted",
  "org.plan_changed",
  "org.seats_changed",
  "member.invited",
  "member.invitation_resent",
  "member.invitation_revoked",
  "member.invitation_accepted",
  "member.removed",
  "member.role_changed",
  "member.left",
  "api_key.created",
  "api_key.revoked",
  "webhook.created",
  "webhook.updated",
  "webhook.deleted",
  "sso.configured",
  "sso.disabled",
  "sso.login",
  "domain.added",
  "domain.verified",
  "domain.removed",
  "policy.updated",
  "package.uploaded",
  "package.deleted",
  "test_run.created",
  "browser_matrix.created",
  "report.created",
  "report.published",
  "report.unpublished",
  "report.shared",
  "share.revoked",
  "export.requested",
  "export.completed",
  "export.failed",
  "export.downloaded",
  "api_key.used",
  "data.deleted",
] as const;

export function generateDomainVerificationToken(): string {
  return `extensionlab-verify-${randomBytes(16).toString("hex")}`;
}
