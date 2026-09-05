import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { withIdempotency } from "@/lib/idempotency/service";
import { createQueuedTestRun } from "@/lib/testing/run-service";
import { createMatrixRun } from "@/lib/testing/matrix-service";
import { getOrgPackage } from "@/lib/db/repositories/packages";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { readVerifiedPackageBytesForOrg } from "@/lib/api/v1-packages-support";
import { recordAuditEvent } from "@/lib/audit/service";
import { dispatchOrganizationEvent } from "@/lib/webhooks/dispatch";
import { auditApiKeyUse } from "@/lib/api-keys/service";
import { AppError } from "@/lib/observability/errors";
import { isBrowserId } from "@/lib/browsers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/test-runs — queue automated tests for a stored package.
 * `browsers` with one entry runs a single-browser run; several entries create
 * a browser matrix. Quota, entitlements and concurrency are enforced by the
 * same server-side services the dashboard uses — API calls never bypass them.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return withApiKey(request, { scope: "tests:write", rateClass: "test", action: "org:tests:run" }, async (context) => {
    try {
      const body = (await request.json().catch(() => null)) as { packageId?: unknown; suiteId?: unknown; browsers?: unknown; testUrl?: unknown } | null;
      if (!body || typeof body.packageId !== "string") throw new AppError("INVALID_INPUT", { message: "packageId is required." });
      const packageRow = getOrgPackage(context.principal.organizationId, body.packageId);
      if (!packageRow) throw new AppError("NOT_FOUND", { message: "Package not found." });
      const browsersRaw = Array.isArray(body.browsers) ? body.browsers : ["chromium"];
      const browsers = browsersRaw.filter((browser): browser is string => typeof browser === "string" && isBrowserId(browser));
      if (browsers.length === 0) throw new AppError("INVALID_INPUT", { message: "browsers must contain at least one supported browser id." });
      const suiteId = typeof body.suiteId === "string" ? body.suiteId : "core";
      const testUrl = typeof body.testUrl === "string" && body.testUrl.trim() !== "" ? body.testUrl.trim() : undefined;
      const idempotencyKey = request.headers.get("idempotency-key");
      const fingerprint = `${context.principal.organizationId}:${body.packageId}:${suiteId}:${browsers.join(",")}:${testUrl ?? ""}`;

      const result = await withIdempotency(
        { type: "organization", id: context.principal.organizationId },
        idempotencyKey,
        "POST /api/v1/test-runs",
        fingerprint,
        async () => {
          const bytes = await readVerifiedPackageBytesForOrg(context.principal.organizationId, body.packageId as string);
          const analysis = await analyzeZipBytes(bytes, "package.zip");
          if (browsers.length === 1 && browsers[0] === "chromium") {
            const created = createQueuedTestRun({
              userId: context.principal.apiKey.created_by,
              packageId: packageRow.id,
              analysis,
              extensionId: packageRow.extension_id,
              ...(testUrl ? { testUrl } : {}),
              organizationId: context.principal.organizationId,
            });
            recordAuditEvent({
              organizationId: context.principal.organizationId,
              actorUserId: context.principal.apiKey.created_by,
              actorApiKeyId: context.principal.apiKey.id,
              action: "test_run.created",
              resourceType: "test_run",
              resourceId: created.runId,
              requestId: context.requestId,
              ip: context.ip,
              metadata: { via: "api", browsers: "chromium" },
            });
            dispatchOrganizationEvent(context.principal.organizationId, "test_run.created", { runId: created.runId, organizationId: context.principal.organizationId });
            return { status: 202, body: { testRun: { id: created.runId, status: "queued" }, job: { id: created.jobId } } };
          }
          const created = await createMatrixRun({
            userId: context.principal.apiKey.created_by,
            packageId: packageRow.id,
            extensionId: packageRow.extension_id,
            analysis,
            browsers,
            suiteId,
            ...(testUrl ? { testUrl } : {}),
            organizationId: context.principal.organizationId,
          });
          recordAuditEvent({
            organizationId: context.principal.organizationId,
            actorUserId: context.principal.apiKey.created_by,
            actorApiKeyId: context.principal.apiKey.id,
            action: "test_run.created",
            resourceType: "browser_matrix",
            resourceId: created.matrixRunId,
            requestId: context.requestId,
            ip: context.ip,
            metadata: { via: "api", browsers: browsers.join(",") },
          });
          dispatchOrganizationEvent(context.principal.organizationId, "browser_matrix.created", { matrixRunId: created.matrixRunId, organizationId: context.principal.organizationId, browsers });
          return { status: 202, body: { browserMatrix: { id: created.matrixRunId, status: "queued", executions: created.executions }, suite: created.suite } };
        },
      );
      auditApiKeyUse(context.principal, "test_run.created", null, context.requestId, context.ip, true);
      return NextResponse.json(result.body, { status: result.status });
    } catch (error) {
      auditApiKeyUse(context.principal, "test_run.created", null, context.requestId, context.ip, false);
      return apiErrorResponse(error, context.requestId);
    }
  });
}
