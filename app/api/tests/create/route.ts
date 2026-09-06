import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp, validateIncomingTestUrl } from "@/lib/runtime/api-helpers";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { canUploadPackage } from "@/lib/billing/entitlements";
import { ApiError, apiErrorResponse, assertEntitled, badRequest, requestIdFrom, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { getOwnedExtension } from "@/lib/db/repositories/extensions";
import { isSafeId } from "@/lib/auth/validation";
import { storeExtensionPackage } from "@/lib/packages/service";
import { createQueuedTestRun } from "@/lib/testing/run-service";
import { ensureEmbeddedWorker } from "@/lib/jobs/runtime";
import { logger, withLogContext } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates an automated test run.
 *
 * Phase 6 flow: validate + store the package → reserve quota and enqueue an
 * AUTOMATED_TEST job in one transaction → return immediately. The worker owns
 * sandbox execution, so this request never blocks on Docker.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFrom(request);
  return withLogContext({ requestId }, async () => {
    const startedAt = Date.now();
    try {
      requireSameOrigin(request);
      const user = requireApiUser(request);
      const ip = getClientIp(request);
      const rate = await enforceRateLimitAsync("testCreate", `${user.id}:${ip}`);
      if (!rate.ok) throw new ApiError(429, "rate_limited", "Too many test runs. Please wait and try again.");

      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.includes("multipart/form-data")) {
        throw badRequest("Expected an extension file upload.");
      }
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw badRequest("No extension file was provided.");
      if (file.size > MAX_EXTENSION_SIZE) {
        throw new ApiError(400, "invalid_input", "This file is larger than the 25 MB limit.");
      }
      // Plan-level size entitlement (never above the hard platform limit).
      assertEntitled(canUploadPackage(user.id, file.size));
      const urlValue = typeof form.get("testUrl") === "string" ? (form.get("testUrl") as string) : "";
      const urlResult = await validateIncomingTestUrl(urlValue);
      if (!urlResult.ok) {
        throw badRequest(urlResult.reason ?? "This URL cannot be tested from the sandbox.");
      }

      const extensionIdInput = typeof form.get("extensionId") === "string" ? (form.get("extensionId") as string) : "";
      let extensionId: string | null = null;
      if (extensionIdInput) {
        if (!isSafeId(extensionIdInput)) throw badRequest("Invalid extension id.");
        const owned = getOwnedExtension(user.id, extensionIdInput);
        if (!owned) throw new ApiError(404, "not_found", "Extension not found.");
        extensionId = owned.id;
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await storeExtensionPackage({ userId: user.id, bytes, fileName: file.name, extensionId });

      ensureEmbeddedWorker();
      const created = createQueuedTestRun({
        userId: user.id,
        packageId: stored.package.id,
        analysis: stored.analysis,
        extensionId,
        testUrl: urlResult.url,
      });

      logger.info("api.tests.create", { userId: user.id, runId: created.runId, durationMs: Date.now() - startedAt, result: "queued" });
      return NextResponse.json(
        {
          runId: created.runId,
          token: created.token,
          jobId: created.jobId,
          suite: created.suite,
          extensionId,
          packageId: created.packageId,
          status: "queued",
        },
        { status: 201, headers: { "x-request-id": requestId } },
      );
    } catch (error) {
      return apiErrorResponse(error, request);
    }
  });
}
