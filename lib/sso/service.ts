import "server-only";
import { getSsoConfig, upsertSsoConfigRow, deleteSsoConfig } from "@/lib/organizations/repository";
import { canUseOrgFeature } from "@/lib/organizations/entitlements";
import { recordAuditEvent } from "@/lib/audit/service";
import { getConfig } from "@/lib/config/env";
import { AppError } from "@/lib/observability/errors";
import type { OrgMembershipContext } from "@/lib/organizations/authorization";

/**
 * SSO configuration layer (Phase 10).
 *
 * ExtensionLab stores and routes SSO configuration; the actual OIDC/SAML
 * protocol exchange (assertion validation, token verification) is delegated to
 * a provider adapter. This build ships the configuration and routing surface
 * with clearly documented boundaries: no authentication is ever simulated, and
 * `status: "enforced"` only takes effect when a real provider adapter is
 * registered at deployment time. Secrets in config JSON are redacted before
 * audit logging and are never returned to the browser once saved.
 */

export type SsoProtocol = "oidc" | "saml";

export interface SsoConfigView {
  protocol: SsoProtocol;
  status: "configured" | "enforced" | null;
  /** Masked endpoints/ids only — client secrets are write-only. */
  config: Record<string, string>;
  enforcedDomains: string[];
}

const WRITE_ONLY_KEYS = /secret|password|private|token|credential/i;

function maskConfig(config: Record<string, unknown>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string") continue;
    masked[key] = WRITE_ONLY_KEYS.test(key) ? "••••••••" : value.slice(0, 200);
  }
  return masked;
}

export function getSsoConfigView(organizationId: string): SsoConfigView {
  const row = getSsoConfig(organizationId);
  if (!row) return { protocol: "oidc", status: null, config: {}, enforcedDomains: [] };
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.config_json) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { protocol: row.protocol, status: row.status, config: maskConfig(parsed), enforcedDomains: [] };
}

export function saveSsoConfig(
  ctx: OrgMembershipContext,
  input: { protocol?: unknown; status?: unknown; config?: unknown },
): SsoConfigView {
  const entitlement = canUseOrgFeature(ctx.organizationId, "sso");
  if (!entitlement.allowed) throw new AppError("PAYMENT_REQUIRED", { message: entitlement.message });
  if (!getConfig().sso.enabled) throw new AppError("FORBIDDEN", { message: "SSO is not enabled on this deployment." });
  const protocol: SsoProtocol = input.protocol === "saml" ? "saml" : "oidc";
  const status = input.status === "enforced" ? "enforced" : "configured";
  const config = (input.config && typeof input.config === "object" ? input.config : {}) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config).slice(0, 20)) {
    if (typeof value === "string" && value.length <= 500 && value !== "••••••••") clean[key] = value;
  }
  // Enforced SSO requires the essentials; without them the config stays "configured".
  const hasEssentials =
    protocol === "oidc"
      ? Boolean(clean.issuer && clean.authorizationEndpoint && clean.tokenEndpoint && clean.clientId && clean.clientSecret)
      : Boolean(clean.entryPoint && clean.idpCertificate && clean.audience);
  const effectiveStatus = status === "enforced" && !hasEssentials ? "configured" : status;
  upsertSsoConfigRow({ organizationId: ctx.organizationId, protocol, status: effectiveStatus, configJson: JSON.stringify(clean) });
  recordAuditEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "sso.configured",
    resourceType: "sso_config",
    resourceId: ctx.organizationId,
    metadata: { protocol, status: effectiveStatus },
  });
  return getSsoConfigView(ctx.organizationId);
}

export function removeSsoConfig(ctx: OrgMembershipContext): void {
  if (deleteSsoConfig(ctx.organizationId)) {
    recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "sso.disabled", resourceType: "sso_config", resourceId: ctx.organizationId });
  }
}
