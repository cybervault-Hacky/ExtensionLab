import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxConfig } from "@/lib/runtime/config";
import { extractZipToDirectory } from "@/lib/runtime/extract";
import { getClientIp, errorResponse, validateIncomingTestUrl } from "@/lib/runtime/api-helpers";
import { getTestRunManager } from "@/lib/testing/manager-instance";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { discoverTests } from "@/lib/testing/registry";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";
import { ExtensionLabError } from "@/lib/extension/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sessionPath = join(getSandboxConfig().tempRoot, `test_${randomBytes(8).toString("hex")}`);
  try {
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
      clientIp: getClientIp(request),
    });
    return NextResponse.json({ ...created, suite: { total: tests.length } }, { status: 201 });
  } catch (error) {
    await rm(sessionPath, { recursive: true, force: true }).catch(() => undefined);
    void error;
    const label = error instanceof ExtensionLabError ? error.message : "We could not prepare the automated test suite.";
    return errorResponse(new Error(label));
  }
}
