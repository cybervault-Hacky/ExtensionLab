import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxConfig } from "@/lib/runtime/config";
import { extractZipToDirectory } from "@/lib/runtime/extract";
import { getClientIp, validateIncomingTestUrl } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, assertEntitled, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { canUploadPackage } from "@/lib/billing/entitlements";
import { getSandboxManager } from "@/lib/runtime/sandbox-manager-instance";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { enforceRateLimitAsync } from "@/lib/auth/rate-limit-policy";
import { rateLimited } from "@/lib/auth/api";
import type { CreateSandboxResponse } from "@/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sessionPath = join(
    getSandboxConfig().tempRoot,
    `pkg_${randomBytes(8).toString("hex")}`,
  );

  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const limit = await enforceRateLimitAsync("sandboxCreate", `${user.id}:${getClientIp(request)}`);
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: { message: "Expected an extension file upload." } },
        { status: 400 },
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: { message: "No extension file was provided." } },
        { status: 400 },
      );
    }

    if (file.size > MAX_EXTENSION_SIZE) {
      return NextResponse.json(
        { error: { message: "This file is larger than the 25 MB limit." } },
        { status: 413 },
      );
    }
    assertEntitled(canUploadPackage(user.id, file.size));

    const urlValue = typeof form.get("testUrl") === "string" ? form.get("testUrl") as string : "";
    const urlResult = await validateIncomingTestUrl(urlValue);
    if (!urlResult.ok) {
      return NextResponse.json(
        { error: { message: urlResult.reason ?? "This URL cannot be tested from the sandbox." } },
        { status: 400 },
      );
    }

    await mkdir(sessionPath, { recursive: true });
    const bytes = new Uint8Array(await file.arrayBuffer());
    await extractZipToDirectory(bytes, sessionPath);

    const manager = getSandboxManager();
    const result: CreateSandboxResponse = await manager.create({
      sourcePath: sessionPath,
      testUrl: urlResult.url,
      clientIp: getClientIp(request),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    await rm(sessionPath, { recursive: true, force: true }).catch(() => undefined);
    return apiErrorResponse(error);
  }
}
