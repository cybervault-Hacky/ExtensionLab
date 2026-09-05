import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, assertEntitled, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { enforceRateLimit } from "@/lib/auth/rate-limit-policy";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { isSafeId } from "@/lib/auth/validation";
import { readOwnedPackageBytes, storeExtensionPackage } from "@/lib/packages/service";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { ExtensionLabError } from "@/lib/extension/errors";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { canUploadPackage } from "@/lib/billing/entitlements";
import { validateIncomingTestUrl } from "@/lib/runtime/api-helpers";
import { createMatrixRun } from "@/lib/testing/matrix-service";
import { listMatrixRuns } from "@/lib/db/repositories/browser-matrix";
import { ensureEmbeddedWorker } from "@/lib/jobs/runtime";
import { AppError } from "@/lib/observability/errors";
import { logger, withLogContext } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tests/matrix — create a browser matrix run.
 *
 * Flow: authenticate → validate ownership of the exact package version →
 * validate browser ids → validate availability → validate entitlements →
 * calculate quota → reserve atomically → create matrix run → queue child
 * executions. Client-supplied quota/concurrency values are never trusted.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? "";
  return withLogContext({ requestId }, async () => {
    const startedAt = Date.now();
    try {
      requireSameOrigin(request);
      const user = requireApiUser(request);
      const ip = getClientIp(request);
      const rate = enforceRateLimit("testCreate", `${user.id}:${ip}`);
      if (!rate.ok) throw new AppError("RATE_LIMITED");

      // Accept both { packageId } JSON (reuse a stored, hash-verified package)
      // and multipart uploads (file + fields) that store a fresh package first.
      const contentType = request.headers.get("content-type") ?? "";
      let packageId = "";
      let browsers: string[] = [];
      let suiteId: string | null = null;
      let testUrl: string | undefined;
      let analysis;
      let extensionId: string | null = null;

      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) throw badRequest("No extension file was provided.");
        if (file.size > MAX_EXTENSION_SIZE) {
          throw badRequest("This file is larger than the 25 MB limit.");
        }
        assertEntitled(canUploadPackage(user.id, file.size));
        const urlValue = typeof form.get("testUrl") === "string" ? (form.get("testUrl") as string) : "";
        const urlResult = await validateIncomingTestUrl(urlValue);
        if (!urlResult.ok) {
          throw badRequest(urlResult.reason ?? "This URL cannot be tested from the sandbox.");
        }
        testUrl = urlResult.url;
        const browsersField = form.get("browsers");
        browsers =
          typeof browsersField === "string"
            ? browsersField.split(",").map((id) => id.trim()).filter(Boolean)
            : [];
        suiteId = typeof form.get("suiteId") === "string" ? (form.get("suiteId") as string).trim() || null : null;
        const extensionIdField = form.get("extensionId");
        if (typeof extensionIdField === "string" && extensionIdField.trim() !== "") {
          const { getOwnedExtension } = await import("@/lib/db/repositories/extensions");
          const owned = getOwnedExtension(user.id, extensionIdField.trim());
          if (!owned) throw new AppError("NOT_FOUND", { message: "Extension not found." });
          extensionId = owned.id;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const stored = await storeExtensionPackage({
          userId: user.id,
          bytes,
          fileName: file.name,
          extensionId,
        });
        packageId = stored.package.id;
        analysis = stored.analysis;
      } else {
        const body = (await request.json().catch(() => null)) as {
          packageId?: unknown;
          browsers?: unknown;
          suiteId?: unknown;
          testUrl?: unknown;
        } | null;
        if (!body) throw badRequest("Invalid request body.");
        packageId = typeof body.packageId === "string" ? body.packageId : "";
        browsers = Array.isArray(body.browsers)
          ? body.browsers.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim())
          : [];
        suiteId = typeof body.suiteId === "string" && body.suiteId.trim() !== "" ? body.suiteId.trim() : null;
        testUrl = typeof body.testUrl === "string" && body.testUrl.trim() !== "" ? body.testUrl.trim() : undefined;
      }

      if (!packageId || !isSafeId(packageId)) throw badRequest("A valid package id is required.");
      if (browsers.length === 0) throw badRequest("Select at least one browser.");

      if (!analysis) {
        // Ownership + integrity: the stored package is read and hash-verified
        // (SHA-256) before anything is scheduled; users can never point a run
        // at an arbitrary path.
        const { row: pkg, bytes } = await readOwnedPackageBytes(user.id, packageId);
        extensionId = pkg.extension_id;
        try {
          analysis = await analyzeZipBytes(bytes, pkg.original_name ?? "package.zip");
        } catch (error) {
          throw new AppError("INVALID_EXTENSION", {
            message: error instanceof ExtensionLabError ? error.message : undefined,
            cause: error,
          });
        }
      }

      ensureEmbeddedWorker();
      const created = await createMatrixRun({
        userId: user.id,
        packageId,
        extensionId,
        browsers,
        suiteId,
        testUrl,
        analysis,
      });

      logger.info("api.tests.matrix.create", {
        userId: user.id,
        matrixRunId: created.matrixRunId,
        browsers,
        durationMs: Date.now() - startedAt,
        result: "queued",
      });
      return NextResponse.json(
        {
          matrixRunId: created.matrixRunId,
          executions: created.executions,
          suite: created.suite,
          status: "queued",
        },
        { status: 201 },
      );
    } catch (error) {
      return apiErrorResponse(error, request);
    }
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "12") || 12));
    const browser = url.searchParams.get("browser") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const data = listMatrixRuns(user.id, { page, limit, browser, status });
    return NextResponse.json({
      items: data.items.map((row) => ({
        id: row.id,
        status: row.status,
        suiteId: row.test_suite_id,
        suiteName: row.test_suite_name,
        browsers: JSON.parse(row.browsers_json) as string[],
        compatibilityScore: row.compatibility_score,
        coverage: row.coverage,
        extensionName: row.extensionName,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      })),
      page,
      limit,
      total: data.total,
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
