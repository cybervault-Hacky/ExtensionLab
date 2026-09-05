import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { authorizeOrgAction } from "@/lib/organizations/authorization";
import { createDomainRow, listDomains } from "@/lib/organizations/repository";
import { generateDomainVerificationToken, recordAuditEvent } from "@/lib/audit/service";
import { AppError } from "@/lib/observability/errors";
import { verifyDomainDnsTxt } from "@/lib/sso/domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const DOMAIN_PATTERN = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** GET — domains + verification state (admin+). */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    authorizeOrgAction(id, user.id, "org:domains:manage");
    return NextResponse.json({
      domains: listDomains(id).map((domain) => ({
        id: domain.id,
        domain: domain.domain,
        verified: domain.verified_at !== null,
        verifiedAt: domain.verified_at,
        createdAt: domain.created_at,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

/** POST — add a domain (?verify=<domainId> runs the DNS TXT check instead). */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    const ctx = authorizeOrgAction(id, user.id, "org:domains:manage");
    const verifyId = new URL(request.url).searchParams.get("verify");
    if (verifyId) {
      const result = await verifyDomainDnsTxt(ctx, id, verifyId);
      return NextResponse.json(result);
    }
    const body = (await request.json().catch(() => null)) as { domain?: unknown } | null;
    const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : "";
    if (!DOMAIN_PATTERN.test(domain)) throw badRequest("Enter a valid domain (e.g. example.com).");
    const token = generateDomainVerificationToken();
    let row;
    try {
      row = createDomainRow({ organizationId: id, domain, verificationToken: token });
    } catch {
      throw new AppError("CONFLICT", { message: "This domain is already registered." });
    }
    recordAuditEvent({ organizationId: id, actorUserId: user.id, action: "domain.added", resourceType: "domain", resourceId: row.id, metadata: { domain } });
    return NextResponse.json(
      {
        domain: { id: row.id, domain: row.domain, verified: false },
        // Publish this TXT record, then call POST again with ?verify=<id>.
        txtRecord: { name: `_extensionlab-verify.${domain}`, value: token },
      },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
