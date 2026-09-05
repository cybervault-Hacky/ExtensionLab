import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxConfig } from "@/lib/runtime/config";
import { extractZipToDirectory } from "@/lib/runtime/extract";
import { getClientIp, validateIncomingTestUrl } from "@/lib/runtime/api-helpers";
import { getTestRunManager } from "@/lib/testing/manager-instance";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { discoverTests } from "@/lib/testing/registry";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { ExtensionLabError } from "@/lib/extension/errors";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  requireApiUser,
  requireSameOrigin,
  usageLimit,
} from "@/lib/auth/api";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getOwnedExtension } from "@/lib/db/repositories/extensions";
import {
  canCreateTestRun,
  persistNewTestRun,
  registerPendingTestRun,
} from "@/lib/testing/persistence";
import { isSafeId } from "@/lib/auth/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sessionPath = join(getSandboxConfig().tempRoot, `test_${randomBytes(8).toString("hex")}`);
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const ip = getClientIp(request);
    const rate = checkRateLimit(`test-create:${user.id}:${ip}`, 20, 60 * 1000);
    if (!rate.ok) throw new ApiError(429, "rate_limited", "Too many test runs. Please wait and try again.");
    if (!canCreateTestRun(user.id)) throw usageLimit("automated test run");

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: { message: "Expected an extension file upload." } }, { status: 400 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: { message: "No extension file was provided." } }, { status: 400 });
    }
    if (file.size > MAX_EXTENSION_SIZE) {
      return NextResponse.json({ error: { message: "This file is larger than the 25 MB limit." } }, { status: 413 });
    }
    const urlValue = typeof form.get("testUrl") === "string" ? form.get("testUrl") as string : "";
    const urlResult = await validateIncomingTestUrl(urlValue);
    if (!urlResult.ok) {
      return NextResponse.json({ error: { message: urlResult.reason ?? "This URL cannot be tested from the sandbox." } }, { status: 400 });
    }

    const extensionIdInput = typeof form.get("extensionId") === "string" ? form.get("extensionId") as string : "";
    let extensionId: string | null = null;
    if (extensionIdInput) {
      if (!isSafeId(extensionIdInput)) throw badRequest("Invalid extension id.");
      const owned = getOwnedExtension(user.id, extensionIdInput);
      if (!owned) throw new ApiError(404, "not_found", "Extension not found.");
      extensionId = owned.id;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const analysis = await analyzeZipBytes(bytes, file.name);
    const { tests } = discoverTests(analysis);

    await mkdir(sessionPath, { recursive: true });
    await extractZipToDirectory(bytes, sessionPath);

    const manager = getTestRunManager();
    const created = await manager.create({
      sourcePath: sessionPath,
      analysis,
      tests,
      testUrl: urlResult.url,
      clientIp: ip,
    });
    persistNewTestRun({ runId: created.runId, userId: user.id, extensionId });
    registerPendingTestRun(created.runId, user.id);
    return NextResponse.json({ ...created, suite: { total: tests.length }, extensionId }, { status: 201 });
  } catch (error) {
    await rm(sessionPath, { recursive: true, force: true }).catch(() => undefined);
    void error;
    return apiErrorResponse(
      error instanceof ExtensionLabError ? new ApiError(400, "invalid_input", error.message) : error,
    );
  }
}
