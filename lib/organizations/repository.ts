import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getDb, transaction } from "@/lib/db/client";
import { generateDbId } from "@/lib/db/ids";
import { findUserByEmail } from "@/lib/db/repositories/users";
import type {
  OrganizationApiKeyRow,
  OrganizationAuditEventRow,
  OrganizationDomainRow,
  OrganizationExportRow,
  OrganizationInvitationRow,
  OrganizationMemberRow,
  OrganizationPolicyRow,
  OrganizationRow,
  OrganizationSsoConfigRow,
  OrganizationWebhookDeliveryRow,
  OrganizationWebhookRow,
} from "@/lib/db/schema/types";
import type { OrganizationRole } from "./types";

/** Data-access layer for Phase 10 organization tables. IDs are app-generated. */

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInvitationToken(): string {
  return `orginv_${randomBytes(24).toString("base64url")}`;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

// ---------------------------------------------------------------------------

export function createOrganizationRow(input: {
  name: string;
  ownerUserId: string;
  planId: string;
  slugHint?: string | null;
}): { row: OrganizationRow; member: OrganizationMemberRow } {
  const db = getDb();
  const now = Date.now();
  return transaction(db, () => {
    let slug = slugify(input.slugHint || input.name);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? slug : `${slug}-${randomBytes(3).toString("hex")}`;
      const exists = db.prepare("SELECT 1 FROM organizations WHERE slug = ?").get(candidate);
      if (!exists) {
        slug = candidate;
        break;
      }
    }
    const id = generateDbId("org");
    db.prepare(
      `INSERT INTO organizations (id, name, slug, owner_user_id, plan_id, plan_status, seats, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'none', 1, '{}', ?, ?)`,
    ).run(id, input.name, slug, input.ownerUserId, input.planId, now, now);
    const memberId = generateDbId("orgm");
    db.prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).run(memberId, id, input.ownerUserId, now);
    return {
      row: getOrganizationById(id)!,
      member: getMembership(id, input.ownerUserId)!,
    };
  });
}

export function getOrganizationById(id: string): OrganizationRow | null {
  const row = getDb().prepare("SELECT * FROM organizations WHERE id = ?").get(id);
  return (row as OrganizationRow | undefined) ?? null;
}

export function getOrganizationBySlug(slug: string): OrganizationRow | null {
  const row = getDb().prepare("SELECT * FROM organizations WHERE slug = ?").get(slug);
  return (row as OrganizationRow | undefined) ?? null;
}

export function updateOrganizationRow(id: string, input: Partial<{ name: string; settings_json: string; plan_id: string; plan_status: string; provider: string | null; provider_subscription_id: string | null; seats: number }>): void {
  const current = getOrganizationById(id);
  if (!current) return;
  getDb()
    .prepare(
      `UPDATE organizations SET name = ?, settings_json = ?, plan_id = ?, plan_status = ?, provider = ?, provider_subscription_id = ?, seats = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.name ?? current.name,
      input.settings_json ?? current.settings_json,
      input.plan_id ?? current.plan_id,
      input.plan_status ?? current.plan_status,
      input.provider !== undefined ? input.provider : current.provider,
      input.provider_subscription_id !== undefined ? input.provider_subscription_id : current.provider_subscription_id,
      input.seats ?? current.seats,
      Date.now(),
      id,
    );
}

export function deleteOrganizationRow(id: string): void {
  getDb().prepare("DELETE FROM organizations WHERE id = ?").run(id);
}

export function listOrganizationsForUser(userId: string): Array<OrganizationRow & { role: OrganizationRole }> {
  const rows = getDb()
    .prepare(
      `SELECT o.*, m.role AS member_role FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
       WHERE m.user_id = ? ORDER BY o.created_at ASC`,
    )
    .all(userId) as unknown as Array<OrganizationRow & { member_role: OrganizationRole }>;
  return rows.map((row) => ({ ...row, role: row.member_role }));
}

// Members -------------------------------------------------------------------

export function getMembership(organizationId: string, userId: string): OrganizationMemberRow | null {
  const row = getDb()
    .prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?")
    .get(organizationId, userId);
  return (row as OrganizationMemberRow | undefined) ?? null;
}

export function listMembers(organizationId: string): Array<OrganizationMemberRow & { email: string; name: string | null }> {
  return getDb()
    .prepare(
      `SELECT m.*, u.email AS email, u.name AS name FROM organization_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? ORDER BY m.created_at ASC LIMIT 500`,
    )
    .all(organizationId) as unknown as Array<OrganizationMemberRow & { email: string; name: string | null }>;
}

export function countMembers(organizationId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?").get(organizationId) as { n: number };
  return row.n;
}

export function countOrganizationsForUser(userId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM organization_members WHERE user_id = ?").get(userId) as { n: number };
  return row.n;
}

export function insertMember(input: { organizationId: string; userId: string; role: Exclude<OrganizationRole, "owner"> }): OrganizationMemberRow {
  const id = generateDbId("orgm");
  getDb()
    .prepare("INSERT INTO organization_members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, input.organizationId, input.userId, input.role, Date.now());
  return getMembership(input.organizationId, input.userId)!;
}

export function updateMemberRole(organizationId: string, userId: string, role: OrganizationRole): boolean {
  const result = getDb()
    .prepare("UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?")
    .run(role, organizationId, userId);
  return Number(result.changes) > 0;
}

export function removeMember(organizationId: string, userId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?")
    .run(organizationId, userId);
  return Number(result.changes) > 0;
}

// Invitations ----------------------------------------------------------------

export type InvitationWithOrganization = OrganizationInvitationRow & { organization_name: string; organization_slug: string };

export function createInvitationRow(input: {
  organizationId: string;
  email: string;
  role: Exclude<OrganizationRole, "owner">;
  tokenHash: string;
  invitedBy: string;
  expiresAt: number;
}): OrganizationInvitationRow {
  const id = generateDbId("orgi");
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.organizationId, input.email, input.role, input.tokenHash, input.invitedBy, input.expiresAt, now, now);
  return getInvitationById(id)!;
}

export function getInvitationById(id: string): OrganizationInvitationRow | null {
  const row = getDb().prepare("SELECT * FROM organization_invitations WHERE id = ?").get(id);
  return (row as OrganizationInvitationRow | undefined) ?? null;
}

export function getInvitationByTokenHash(tokenHash: string): OrganizationInvitationRow | null {
  const row = getDb().prepare("SELECT * FROM organization_invitations WHERE token_hash = ?").get(tokenHash);
  return (row as OrganizationInvitationRow | undefined) ?? null;
}

/** Phase 10: invitation inbox — open invitations addressed to an email. */
export function listOpenInvitationsForEmail(email: string): InvitationWithOrganization[] {
  return getDb()
    .prepare(
      `SELECT i.*, o.name AS organization_name, o.slug AS organization_slug
       FROM organization_invitations i
       JOIN organizations o ON o.id = i.organization_id
       WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
       ORDER BY i.created_at DESC`,
    )
    .all(email, Date.now()) as unknown as InvitationWithOrganization[];
}

export function listInvitations(organizationId: string): OrganizationInvitationRow[] {
  return getDb()
    .prepare("SELECT * FROM organization_invitations WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200")
    .all(organizationId) as unknown as OrganizationInvitationRow[];
}

export function openInvitationForEmail(organizationId: string, email: string): OrganizationInvitationRow | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM organization_invitations WHERE organization_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get(organizationId, email);
  return (row as OrganizationInvitationRow | undefined) ?? null;
}

export function updateInvitationRow(id: string, input: Partial<{ token_hash: string; expires_at: number; accepted_at: number; accepted_by: string; revoked_at: number; resend_count: number }>): void {
  const current = getInvitationById(id);
  if (!current) return;
  getDb()
    .prepare(
      `UPDATE organization_invitations SET token_hash = ?, expires_at = ?, accepted_at = ?, accepted_by = ?, revoked_at = ?, resend_count = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.token_hash ?? current.token_hash,
      input.expires_at ?? current.expires_at,
      input.accepted_at ?? current.accepted_at,
      input.accepted_by ?? current.accepted_by,
      input.revoked_at ?? current.revoked_at,
      input.resend_count ?? current.resend_count,
      Date.now(),
      id,
    );
}

// Domains ----------------------------------------------------------------------

export function createDomainRow(input: { organizationId: string; domain: string; verificationToken: string }): OrganizationDomainRow {
  const id = generateDbId("orgd");
  getDb()
    .prepare("INSERT INTO organization_domains (id, organization_id, domain, verification_token, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, input.organizationId, input.domain, input.verificationToken, Date.now());
  return getDomainById(id)!;
}

export function getDomainById(id: string): OrganizationDomainRow | null {
  const row = getDb().prepare("SELECT * FROM organization_domains WHERE id = ?").get(id);
  return (row as OrganizationDomainRow | undefined) ?? null;
}

export function listDomains(organizationId: string): OrganizationDomainRow[] {
  return getDb()
    .prepare("SELECT * FROM organization_domains WHERE organization_id = ? ORDER BY created_at ASC LIMIT 100")
    .all(organizationId) as unknown as OrganizationDomainRow[];
}

export function markDomainVerified(id: string, verifiedBy: string): void {
  getDb().prepare("UPDATE organization_domains SET verified_at = ?, verified_by = ? WHERE id = ? AND verified_at IS NULL").run(Date.now(), verifiedBy, id);
}

export function deleteDomainRow(organizationId: string, id: string): boolean {
  const result = getDb().prepare("DELETE FROM organization_domains WHERE id = ? AND organization_id = ?").run(id, organizationId);
  return Number(result.changes) > 0;
}

// SSO configs -------------------------------------------------------------------

export function upsertSsoConfigRow(input: { organizationId: string; protocol: "oidc" | "saml"; status: "configured" | "enforced"; configJson: string }): OrganizationSsoConfigRow {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM organization_sso_configs WHERE organization_id = ?").get(input.organizationId) as OrganizationSsoConfigRow | undefined;
  if (existing) {
    db.prepare("UPDATE organization_sso_configs SET protocol = ?, status = ?, config_json = ?, updated_at = ? WHERE organization_id = ?")
      .run(input.protocol, input.status, input.configJson, now, input.organizationId);
  } else {
    const id = generateDbId("orgs");
    db.prepare(
      "INSERT INTO organization_sso_configs (id, organization_id, protocol, status, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, input.organizationId, input.protocol, input.status, input.configJson, now, now);
  }
  return db.prepare("SELECT * FROM organization_sso_configs WHERE organization_id = ?").get(input.organizationId) as unknown as OrganizationSsoConfigRow;
}

export function getSsoConfig(organizationId: string): OrganizationSsoConfigRow | null {
  const row = getDb().prepare("SELECT * FROM organization_sso_configs WHERE organization_id = ?").get(organizationId);
  return (row as OrganizationSsoConfigRow | undefined) ?? null;
}

export function deleteSsoConfig(organizationId: string): boolean {
  const result = getDb().prepare("DELETE FROM organization_sso_configs WHERE organization_id = ?").run(organizationId);
  return Number(result.changes) > 0;
}

export function findSsoConfigForEmailDomain(domain: string): OrganizationSsoConfigRow | null {
  const row = getDb()
    .prepare(
      `SELECT s.* FROM organization_sso_configs s
       JOIN organization_domains d ON d.organization_id = s.organization_id
       WHERE d.domain = ? AND d.verified_at IS NOT NULL AND s.status = 'enforced'
       LIMIT 1`,
    )
    .get(domain);
  return (row as OrganizationSsoConfigRow | undefined) ?? null;
}

// API keys ------------------------------------------------------------------------

export function insertApiKeyRow(input: Omit<OrganizationApiKeyRow, "last_used_at">): OrganizationApiKeyRow {
  getDb()
    .prepare(
      `INSERT INTO organization_api_keys (id, organization_id, name, prefix, key_hash, scopes_json, created_by, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.organization_id, input.name, input.prefix, input.key_hash, input.scopes_json, input.created_by, input.created_at, input.expires_at, input.revoked_at);
  return getDb().prepare("SELECT * FROM organization_api_keys WHERE id = ?").get(input.id) as unknown as OrganizationApiKeyRow;
}

export function getApiKeyById(id: string): OrganizationApiKeyRow | null {
  const row = getDb().prepare("SELECT * FROM organization_api_keys WHERE id = ?").get(id);
  return (row as OrganizationApiKeyRow | undefined) ?? null;
}

export function getApiKeyByHash(keyHash: string): OrganizationApiKeyRow | null {
  const row = getDb().prepare("SELECT * FROM organization_api_keys WHERE key_hash = ?").get(keyHash);
  return (row as OrganizationApiKeyRow | undefined) ?? null;
}

export function listApiKeys(organizationId: string): OrganizationApiKeyRow[] {
  return getDb()
    .prepare("SELECT * FROM organization_api_keys WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200")
    .all(organizationId) as unknown as OrganizationApiKeyRow[];
}

export function countApiKeys(organizationId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM organization_api_keys WHERE organization_id = ? AND revoked_at IS NULL").get(organizationId) as { n: number };
  return row.n;
}

export function revokeApiKey(organizationId: string, id: string): boolean {
  const result = getDb()
    .prepare("UPDATE organization_api_keys SET revoked_at = ? WHERE id = ? AND organization_id = ? AND revoked_at IS NULL")
    .run(Date.now(), id, organizationId);
  return Number(result.changes) > 0;
}

export function touchApiKeyLastUsed(id: string): void {
  getDb().prepare("UPDATE organization_api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}

// Webhooks ---------------------------------------------------------------------------

export function insertWebhookRow(input: { organizationId: string; url: string; secret: string; events: string[]; createdBy: string }): OrganizationWebhookRow {
  const id = generateDbId("orgw");
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO organization_webhooks (id, organization_id, url, secret, events_json, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
    )
    .run(id, input.organizationId, input.url, input.secret, JSON.stringify(input.events), input.createdBy, now, now);
  return getDb().prepare("SELECT * FROM organization_webhooks WHERE id = ?").get(id) as unknown as OrganizationWebhookRow;
}

export function getWebhookById(organizationId: string, id: string): OrganizationWebhookRow | null {
  const row = getDb().prepare("SELECT * FROM organization_webhooks WHERE id = ? AND organization_id = ?").get(id, organizationId);
  return (row as OrganizationWebhookRow | undefined) ?? null;
}

export function listWebhooks(organizationId: string): OrganizationWebhookRow[] {
  return getDb()
    .prepare("SELECT * FROM organization_webhooks WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(organizationId) as unknown as OrganizationWebhookRow[];
}

export function listActiveWebhooksForEvent(organizationId: string, eventType: string): OrganizationWebhookRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM organization_webhooks WHERE organization_id = ? AND active = 1")
    .all(organizationId) as unknown as OrganizationWebhookRow[];
  return rows.filter((row) => {
    try {
      const events = JSON.parse(row.events_json) as string[];
      return events.includes("*") || events.includes(eventType);
    } catch {
      return false;
    }
  });
}

export function countWebhooks(organizationId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM organization_webhooks WHERE organization_id = ?").get(organizationId) as { n: number };
  return row.n;
}

export function updateWebhookRow(organizationId: string, id: string, input: Partial<{ url: string; events_json: string; active: number }>): boolean {
  const current = getWebhookById(organizationId, id);
  if (!current) return false;
  const result = getDb()
    .prepare("UPDATE organization_webhooks SET url = ?, events_json = ?, active = ?, updated_at = ? WHERE id = ? AND organization_id = ?")
    .run(input.url ?? current.url, input.events_json ?? current.events_json, input.active ?? current.active, Date.now(), id, organizationId);
  return Number(result.changes) > 0;
}

export function deleteWebhookRow(organizationId: string, id: string): boolean {
  const result = getDb().prepare("DELETE FROM organization_webhooks WHERE id = ? AND organization_id = ?").run(id, organizationId);
  return Number(result.changes) > 0;
}

export function insertWebhookDeliveryRow(input: { organizationId: string; webhookId: string; eventId: string; eventType: string; payloadJson: string }): OrganizationWebhookDeliveryRow {
  const id = generateDbId("orgwd");
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO organization_webhook_deliveries (id, organization_id, webhook_id, event_id, event_type, payload_json, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
    )
    .run(id, input.organizationId, input.webhookId, input.eventId, input.eventType, input.payloadJson, now, now, now);
  return getDb().prepare("SELECT * FROM organization_webhook_deliveries WHERE id = ?").get(id) as unknown as OrganizationWebhookDeliveryRow;
}

export function getWebhookDelivery(organizationId: string, id: string): OrganizationWebhookDeliveryRow | null {
  const row = getDb().prepare("SELECT * FROM organization_webhook_deliveries WHERE id = ? AND organization_id = ?").get(id, organizationId);
  return (row as OrganizationWebhookDeliveryRow | undefined) ?? null;
}

/** Internal (worker) lookup without org scoping; API paths must use getWebhookDelivery. */
export function getWebhookDeliveryById(id: string): OrganizationWebhookDeliveryRow | null {
  const row = getDb().prepare("SELECT * FROM organization_webhook_deliveries WHERE id = ?").get(id);
  return (row as unknown as OrganizationWebhookDeliveryRow | undefined) ?? null;
}

export function listWebhookDeliveries(input: { organizationId: string; webhookId?: string; limit: number; offset: number }): OrganizationWebhookDeliveryRow[] {
  const rows = input.webhookId
    ? getDb()
        .prepare("SELECT * FROM organization_webhook_deliveries WHERE organization_id = ? AND webhook_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(input.organizationId, input.webhookId, input.limit, input.offset)
    : getDb()
        .prepare("SELECT * FROM organization_webhook_deliveries WHERE organization_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(input.organizationId, input.limit, input.offset);
  return rows as unknown as OrganizationWebhookDeliveryRow[];
}

export function listPendingWebhookDeliveries(now: number, limit = 50): OrganizationWebhookDeliveryRow[] {
  return getDb()
    .prepare("SELECT * FROM organization_webhook_deliveries WHERE status IN ('pending','failed') AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?")
    .all(now, limit) as unknown as OrganizationWebhookDeliveryRow[];
}

export function updateWebhookDelivery(id: string, input: Partial<{ status: OrganizationWebhookDeliveryRow["status"]; attempts: number; next_attempt_at: number | null; last_status_code: number | null; last_error: string | null }>): void {
  const current = getDb().prepare("SELECT * FROM organization_webhook_deliveries WHERE id = ?").get(id) as OrganizationWebhookDeliveryRow | undefined;
  if (!current) return;
  getDb()
    .prepare(
      "UPDATE organization_webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_status_code = ?, last_error = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      input.status ?? current.status,
      input.attempts ?? current.attempts,
      input.next_attempt_at !== undefined ? input.next_attempt_at : current.next_attempt_at,
      input.last_status_code !== undefined ? input.last_status_code : current.last_status_code,
      input.last_error !== undefined ? input.last_error : current.last_error,
      Date.now(),
      id,
    );
}

export function pruneWebhookDeliveries(organizationId: string, keepPerWebhook: number): number {
  // Keeps the newest `keepPerWebhook` terminal deliveries per webhook.
  const db = getDb();
  const webhooks = db.prepare("SELECT id FROM organization_webhooks WHERE organization_id = ?").all(organizationId) as Array<{ id: string }>;
  let removed = 0;
  for (const webhook of webhooks) {
    const cutoff = db
      .prepare(
        "SELECT created_at AS c FROM organization_webhook_deliveries WHERE webhook_id = ? AND status IN ('succeeded','dead_letter') ORDER BY created_at DESC LIMIT 1 OFFSET ?",
      )
      .get(webhook.id, Math.max(0, keepPerWebhook - 1)) as { c: number } | undefined;
    if (!cutoff) continue;
    const result = db
      .prepare("DELETE FROM organization_webhook_deliveries WHERE webhook_id = ? AND status IN ('succeeded','dead_letter') AND created_at < ?")
      .run(webhook.id, cutoff.c);
    removed += Number(result.changes);
  }
  return removed;
}

// Audit --------------------------------------------------------------------------------

export function insertAuditEventRow(input: {
  organizationId: string;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string | null;
  ip: string | null;
  success: boolean;
  metadataJson: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO organization_audit_events (id, organization_id, actor_user_id, actor_api_key_id, action, resource_type, resource_id, request_id, ip, success, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      generateDbId("orga"),
      input.organizationId,
      input.actorUserId,
      input.actorApiKeyId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.requestId,
      input.ip,
      input.success ? 1 : 0,
      input.metadataJson,
      Date.now(),
    );
}

export interface AuditQuery {
  organizationId: string;
  action?: string;
  actorUserId?: string;
  resourceId?: string;
  success?: boolean;
  from?: number;
  to?: number;
  search?: string;
  limit: number;
  offset: number;
}

export function queryAuditEvents(query: AuditQuery): { items: OrganizationAuditEventRow[]; total: number } {
  const clauses: string[] = ["organization_id = ?"];
  const params: Array<string | number> = [query.organizationId];
  if (query.action) {
    clauses.push("action = ?");
    params.push(query.action);
  }
  if (query.actorUserId) {
    clauses.push("actor_user_id = ?");
    params.push(query.actorUserId);
  }
  if (query.resourceId) {
    clauses.push("resource_id = ?");
    params.push(query.resourceId);
  }
  if (query.success !== undefined) {
    clauses.push("success = ?");
    params.push(query.success ? 1 : 0);
  }
  if (query.from !== undefined) {
    clauses.push("created_at >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("created_at <= ?");
    params.push(query.to);
  }
  if (query.search) {
    clauses.push("(action LIKE ? OR resource_type LIKE ? OR resource_id LIKE ?)");
    const needle = `%${query.search.replace(/[%_]/g, "")}%`;
    params.push(needle, needle, needle);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM organization_audit_events ${where}`).get(...params) as { n: number };
  const items = getDb()
    .prepare(`SELECT * FROM organization_audit_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(query.limit, 200), query.offset) as unknown as OrganizationAuditEventRow[];
  return { items, total: total.n };
}

/** Phase 10: orgs to evaluate during audit-retention sweeps. */
export function listOrganizationsForRetentionSweep(): Array<{ id: string }> {
  return getDb().prepare("SELECT id FROM organizations").all() as unknown as Array<{ id: string }>;
}

export function deleteAuditEventsBefore(organizationId: string | null, before: number): number {
  // organizationId null → retention sweep across organizations.
  const sql = organizationId
    ? "DELETE FROM organization_audit_events WHERE organization_id = ? AND created_at < ?"
    : "DELETE FROM organization_audit_events WHERE created_at < ?";
  const result = organizationId ? getDb().prepare(sql).run(organizationId, before) : getDb().prepare(sql).run(before);
  return Number(result.changes);
}

// Policies --------------------------------------------------------------------------------

export function upsertPolicyRow(input: { organizationId: string; name: string; rulesJson: string; createdBy: string }): OrganizationPolicyRow {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM organization_policies WHERE organization_id = ?").get(input.organizationId) as OrganizationPolicyRow | undefined;
  if (existing) {
    db.prepare("UPDATE organization_policies SET name = ?, rules_json = ?, updated_at = ? WHERE organization_id = ?")
      .run(input.name, input.rulesJson, now, input.organizationId);
  } else {
    const id = generateDbId("orgp");
    db.prepare("INSERT INTO organization_policies (id, organization_id, name, rules_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.organizationId, input.name, input.rulesJson, input.createdBy, now, now);
  }
  return db.prepare("SELECT * FROM organization_policies WHERE organization_id = ?").get(input.organizationId) as unknown as OrganizationPolicyRow;
}

export function getPolicy(organizationId: string): OrganizationPolicyRow | null {
  const row = getDb().prepare("SELECT * FROM organization_policies WHERE organization_id = ?").get(organizationId);
  return (row as OrganizationPolicyRow | undefined) ?? null;
}

// Exports ----------------------------------------------------------------------------------

export function insertExportRow(input: { organizationId: string; requestedBy: string; expiresAt: number }): OrganizationExportRow {
  const id = generateDbId("orgx");
  getDb()
    .prepare("INSERT INTO organization_exports (id, organization_id, requested_by, status, expires_at, created_at) VALUES (?, ?, ?, 'queued', ?, ?)")
    .run(id, input.organizationId, input.requestedBy, input.expiresAt, Date.now());
  return getDb().prepare("SELECT * FROM organization_exports WHERE id = ?").get(id) as unknown as OrganizationExportRow;
}

export function getExportRow(organizationId: string, id: string): OrganizationExportRow | null {
  const row = getDb().prepare("SELECT * FROM organization_exports WHERE id = ? AND organization_id = ?").get(id, organizationId);
  return (row as OrganizationExportRow | undefined) ?? null;
}

export function listExportRows(organizationId: string, limit = 20): OrganizationExportRow[] {
  return getDb()
    .prepare("SELECT * FROM organization_exports WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(organizationId, limit) as unknown as OrganizationExportRow[];
}

export function updateExportRow(id: string, input: Partial<{ status: OrganizationExportRow["status"]; storage_key: string; size: number; sha256: string; error: string; finished_at: number }>): void {
  const current = getDb().prepare("SELECT * FROM organization_exports WHERE id = ?").get(id) as OrganizationExportRow | undefined;
  if (!current) return;
  getDb()
    .prepare(
      "UPDATE organization_exports SET status = ?, storage_key = ?, size = ?, sha256 = ?, error = ?, finished_at = ? WHERE id = ?",
    )
    .run(
      input.status ?? current.status,
      input.storage_key ?? current.storage_key,
      input.size ?? current.size,
      input.sha256 ?? current.sha256,
      input.error ?? current.error,
      input.finished_at ?? current.finished_at,
      id,
    );
}

export function listExpiredExports(now: number): OrganizationExportRow[] {
  return getDb()
    .prepare("SELECT * FROM organization_exports WHERE status IN ('completed','failed') AND expires_at < ? LIMIT 100")
    .all(now) as unknown as OrganizationExportRow[];
}

// Publications --------------------------------------------------------------------------------

export function insertPublicationRow(input: { organizationId: string; reportId: string; slug: string; summary: string | null; createdBy: string }) {
  const id = generateDbId("orgpub");
  getDb()
    .prepare("INSERT INTO report_publications (id, organization_id, report_id, slug, summary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.organizationId, input.reportId, input.slug, input.summary, input.createdBy, Date.now());
  return getDb().prepare("SELECT * FROM report_publications WHERE id = ?").get(id);
}

export function getPublicationBySlug(slug: string) {
  return getDb().prepare("SELECT * FROM report_publications WHERE slug = ?").get(slug) ?? null;
}

export function listPublications(organizationId: string) {
  return getDb().prepare("SELECT * FROM report_publications WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100").all(organizationId);
}

export function deletePublicationRow(organizationId: string, id: string): boolean {
  const result = getDb().prepare("DELETE FROM report_publications WHERE id = ? AND organization_id = ?").run(id, organizationId);
  return Number(result.changes) > 0;
}

export { slugify, findUserByEmail };
