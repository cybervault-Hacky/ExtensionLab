import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { withIdempotency } from "@/lib/idempotency/service";
import { storeExtensionPackage } from "@/lib/packages/service";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { recordAuditEvent } from "@/lib/audit/service";
import { AppError } from "@/lib/observability/errors";
import { auditApiKeyUse } from "@/lib/api-keys/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/packages — upload + statically analyze an extension ZIP into
 * the API key's organization. Idempotent when an `Idempotency-Key` header is
 * supplied. The response never includes source contents.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "packages:write", rateClass: "upload", action: "org:packages:upload" }, async (context) => {
    try {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new AppError("INVALID_INPUT", { message: "Attach the extension ZIP in a multipart 'file' field." });
      if (file.size <= 0 || file.size > MAX_EXTENSION_SIZE) throw new AppError("INVALID_INPUT", { message: "The file is empty or larger than 25 MB." });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const idempotencyKey = request.headers.get("idempotency-key");
      const fingerprint = `${context.principal.organizationId}:${file.name}:${file.size}`;

      const result = await withIdempotency(
        { type: "organization", id: context.principal.organizationId },
        idempotencyKey,
        "POST /api/v1/packages",
        fingerprint,
        async () => {
          const stored = await storeExtensionPackage({
            userId: context.principal.apiKey.created_by,
            organizationId: context.principal.organizationId,
            bytes,
            fileName: file.name,
          });
          recordAuditEvent({
            organizationId: context.principal.organizationId,
            actorUserId: context.principal.apiKey.created_by,
            actorApiKeyId: context.principal.apiKey.id,
            action: "package.uploaded",
            resourceType: "package",
            resourceId: stored.package.id,
            requestId: context.requestId,
            ip: context.ip,
            metadata: { sha256: stored.package.sha256, size: String(stored.package.size), via: "api" },
          });
          return {
            status: 201,
            body: {
              package: {
                id: stored.package.id,
                sha256: stored.package.sha256,
                size: stored.package.size,
                version: stored.package.version,
              },
              analysis: {
                healthScore: stored.analysis.healthScore.total,
                manifestVersion: stored.analysis.manifest.manifestVersionLabel,
                issueCount: stored.analysis.issues.length,
              },
            },
          };
        },
      );
      auditApiKeyUse(context.principal, "package.uploaded", null, context.requestId, context.ip, true);
      return NextResponse.json(result.body, { status: result.status });
    } catch (error) {
      auditApiKeyUse(context.principal, "package.uploaded", null, context.requestId, context.ip, false);
      return apiErrorResponse(error, context.requestId);
    }
  });
}
