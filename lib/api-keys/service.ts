import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import { generateDbId } from "@/lib/db/ids";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { recordAuditEvent } from "@/lib/audit/service";
import {
  countApiKeys,
  getApiKeyByHash,
  getApiKeyById,
  getMembership,
  insertApiKeyRow,
  listApiKeys,
  revokeApiKey,
  touchApiKeyLastUsed,
} from "@/lib/organizations/repository";
import { canUseOrgFeature } from "@/lib/organizations/entitlements";
import type { OrganizationApiKeyRow } from "@/lib/db/schema/types";
import type { OrganizationRole } from "@/lib/organizations/types";

/**
 * Customer API keys (Phase 10) — automation keys for the ExtensionLab API,
 * never payment-provider keys.
 *
 * Keys are `el_<prefix>_<secret>`: cryptographically random, shown exactly
 * once, stored only as SHA-256 hashes. The prefix lets customers identify a
 * key in settings without exposing the secret.
 */

export const API_SCOPES = [
  "packages:read",
  "packages:write",
  "analysis:read",
  "analysis:write",
  "tests:read",
  "tests:write",
  "reports:read",
  "browser-matrix:read",
  "browser-matrix:write",
  "webhooks:read",
  "webhooks:write",
  "organization:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && (API_SCOPES as readonly string[]).includes(value);
}

/** Least-privilege default for UI-created keys that omit scopes. */
export const DEFAULT_SCOPES: readonly ApiScope[] = ["packages:read", "analysis:read", "tests:read"];

const KEY_PREFIX = "el";
const PREFIX_LENGTH = 6;

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface CreatedApiKey extends ApiKeyView {
  /** The raw key. Shown exactly once; only its SHA-256 hash is stored. */
  key: string;
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function toView(row: OrganizationApiKeyRow): ApiKeyView {
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(row.scopes_json) as string[];
  } catch {
    scopes = [];
  }
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export function createApiKey(ctx: { userId: string; organizationId: string; requestId?: string | null; ip?: string | null }, input: { name: string; scopes?: unknown; expiresAt?: number | null }): CreatedApiKey {
  const config = getConfig();
  const entitlement = canUseOrgFeature(ctx.organizationId, "apiAccess");
  if (!entitlement.allowed) throw new AppError("PAYMENT_REQUIRED", { message: entitlement.message });
  const actor = getMembership(ctx.organizationId, ctx.userId);
  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) throw new AppError("ROLE_REQUIRED");
  if (countApiKeys(ctx.organizationId) >= config.organizations.maxApiKeysPerOrg) {
    throw new AppError("CONFLICT", { message: "This organization has reached its API key limit." });
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw new AppError("INVALID_INPUT", { message: "API key names must be 1–80 characters." });

  let scopes: ApiScope[];
  if (input.scopes === undefined || input.scopes === null) {
    scopes = [...DEFAULT_SCOPES];
  } else {
    if (!Array.isArray(input.scopes)) throw new AppError("INVALID_INPUT", { message: "scopes must be an array." });
    if (input.scopes.length === 0) throw new AppError("INVALID_INPUT", { message: "Select at least one scope (least privilege)." });
    if (input.scopes.length > config.publicApi.maxScopes) {
      throw new AppError("INVALID_INPUT", { message: `At most ${config.publicApi.maxScopes} scopes per key.` });
    }
    scopes = input.scopes.map((scope) => {
      if (!isApiScope(scope)) throw new AppError("INVALID_INPUT", { message: `Unknown scope: ${String(scope).slice(0, 40)}` });
      return scope;
    });
    if (new Set(scopes).size !== scopes.length) throw new AppError("INVALID_INPUT", { message: "Duplicate scopes are not allowed." });
  }

  const prefix = randomBytes(4).toString("hex").slice(0, PREFIX_LENGTH);
  const secret = randomBytes(32).toString("base64url");
  const raw = `${KEY_PREFIX}_${prefix}_${secret}`;
  const expiresAt = input.expiresAt !== undefined && input.expiresAt !== null ? input.expiresAt : Date.now() + config.publicApi.keyTtlMs;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new AppError("INVALID_INPUT", { message: "The expiration must be in the future." });
  }

  const row = insertApiKeyRow({
    id: generateDbId("elk"),
    organization_id: ctx.organizationId,
    name,
    prefix,
    key_hash: hashKey(raw),
    scopes_json: JSON.stringify(scopes),
    created_by: ctx.userId,
    created_at: Date.now(),
    expires_at: expiresAt,
    revoked_at: null,
  });
  recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "api_key.created", resourceType: "api_key", resourceId: row.id, requestId: ctx.requestId, ip: ctx.ip, metadata: { name, scopes: scopes.join(",") } });
  recordMetric("api_key.created", 1);
  return { ...toView(row), key: raw };
}

export function revokeApiKeyById(ctx: { userId: string; organizationId: string; requestId?: string | null; ip?: string | null }, keyId: string): void {
  const actor = getMembership(ctx.organizationId, ctx.userId);
  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) throw new AppError("ROLE_REQUIRED");
  const row = getApiKeyById(keyId);
  if (!row || row.organization_id !== ctx.organizationId) throw new AppError("NOT_FOUND", { message: "API key not found." });
  if (!revokeApiKey(ctx.organizationId, keyId)) throw new AppError("NOT_FOUND", { message: "API key not found." });
  recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "api_key.revoked", resourceType: "api_key", resourceId: keyId, requestId: ctx.requestId, ip: ctx.ip });
}

export function listOrganizationApiKeys(ctx: { userId: string; organizationId: string }): ApiKeyView[] {
  const actor = getMembership(ctx.organizationId, ctx.userId);
  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) throw new AppError("ROLE_REQUIRED");
  return listApiKeys(ctx.organizationId).map(toView);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface ApiKeyPrincipal {
  apiKey: OrganizationApiKeyRow;
  organizationId: string;
  /** Role of the human who created the key; scope checks also respect it. */
  creatorRole: OrganizationRole;
  scopes: ApiScope[];
}

const AUTH_PATTERN = /^Bearer\s+(el_[a-z0-9]+_[A-Za-z0-9_-]+)$/i;

function extractBearer(request: NextRequest): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = AUTH_PATTERN.exec(header);
  return match ? match[1] : null;
}

let lastTouch = 0;

/** Authenticates a request via API key. Throws typed AppErrors; never leaks which part failed. */
export function authenticateApiKey(request: NextRequest, requiredScope?: ApiScope): ApiKeyPrincipal {
  const config = getConfig();
  if (!config.publicApi.enabled) throw new AppError("API_DISABLED");
  const raw = extractBearer(request);
  if (!raw) throw new AppError("API_KEY_INVALID");
  const row = getApiKeyByHash(hashKey(raw));
  if (!row) {
    recordMetric("api_key.auth_failed", 1, { reason: "unknown_key" });
    throw new AppError("API_KEY_INVALID");
  }
  if (row.revoked_at) {
    recordMetric("api_key.auth_failed", 1, { reason: "revoked" });
    throw new AppError("API_KEY_INVALID");
  }
  if (row.expires_at && Date.now() > row.expires_at) {
    recordMetric("api_key.auth_failed", 1, { reason: "expired" });
    throw new AppError("API_KEY_EXPIRED");
  }
  let scopes: ApiScope[] = [];
  try {
    scopes = JSON.parse(row.scopes_json) as ApiScope[];
  } catch {
    scopes = [];
  }
  if (requiredScope && !scopes.includes(requiredScope)) {
    recordMetric("api_key.scope_denied", 1, { scope: requiredScope });
    throw new AppError("API_SCOPE_DENIED", { message: `This operation requires the "${requiredScope}" scope.` });
  }
  // Throttled last-used touch (avoid a write per request).
  const now = Date.now();
  if (now - lastTouch > 30_000 || row.last_used_at === null) {
    lastTouch = now;
    touchApiKeyLastUsed(row.id);
  }
  const creator = row.created_by;
  const membership = getMembership(row.organization_id, creator);
  const creatorRole: OrganizationRole = membership?.role ?? "viewer";
  recordMetric("api_key.authenticated", 1);
  return { apiKey: row, organizationId: row.organization_id, creatorRole, scopes };
}

/** Timing-safe token comparison helper used by tests. */
export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function auditApiKeyUse(principal: ApiKeyPrincipal, action: string, resourceId: string | null, requestId: string | null, ip: string | null, success: boolean): void {
  recordAuditEvent({
    organizationId: principal.organizationId,
    actorUserId: principal.apiKey.created_by,
    actorApiKeyId: principal.apiKey.id,
    action,
    resourceType: "api",
    resourceId,
    requestId,
    ip,
    success,
  });
  void getDb; // (logger parity; no direct queries here)
  if (!success) logger.warn("api_key.use_denied", { organizationId: principal.organizationId, action, requestId: requestId ?? undefined });
}
