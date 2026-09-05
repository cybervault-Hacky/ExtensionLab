import "server-only";
import { promises as dns } from "node:dns";
import { getDomainById, markDomainVerified } from "@/lib/organizations/repository";
import { recordAuditEvent } from "@/lib/audit/service";
import { AppError } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";
import type { OrgMembershipContext } from "@/lib/organizations/authorization";

/**
 * Real DNS TXT verification for organization domains. The stored token must
 * appear in `_extensionlab-verify.<domain>` before the domain can back SSO
 * routing. DNS is slow: verification is retried by the admin, never auto-asserted.
 */
export async function verifyDomainDnsTxt(ctx: OrgMembershipContext, organizationId: string, domainId: string): Promise<{ domain: string; verified: boolean }> {
  const row = getDomainById(domainId);
  if (!row || row.organization_id !== organizationId) throw new AppError("NOT_FOUND", { message: "Domain not found." });
  if (row.verified_at) return { domain: row.domain, verified: true };
  let records: string[] = [];
  try {
    const result = await dns.resolveTxt(`_extensionlab-verify.${row.domain}`);
    records = result.flat();
  } catch (error) {
    const errorCode = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "DNS_ERROR";
    logger.info("domain.dns_lookup_failed", { domainId, errorCode });
  }
  if (records.includes(row.verification_token)) {
    markDomainVerified(domainId, ctx.userId);
    recordAuditEvent({ organizationId, actorUserId: ctx.userId, action: "domain.verified", resourceType: "domain", resourceId: domainId, metadata: { domain: row.domain } });
    return { domain: row.domain, verified: true };
  }
  recordAuditEvent({ organizationId, action: "domain.verification_failed", resourceType: "domain", resourceId: domainId, success: false, metadata: { domain: row.domain } });
  return { domain: row.domain, verified: false };
}
