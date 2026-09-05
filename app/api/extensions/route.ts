import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ApiError,
  apiErrorResponse,
  badRequest,
  requireApiUser,
  requireSameOrigin,
  usageLimit,
} from "@/lib/auth/api";
import { getClientIp } from "@/lib/runtime/api-helpers";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getActivePlan } from "@/lib/db/plan";
import { usageLimitReached, recordUsage } from "@/lib/db/repositories/usage";
import {
  createExtension,
  deleteExtension,
  getOwnedExtension,
  listExtensions,
  updateExtensionFromAnalysis,
} from "@/lib/db/repositories/extensions";
import { createSnapshot } from "@/lib/db/repositories/snapshots";
import { countTestRuns } from "@/lib/db/repositories/test-runs";
import { parsePagination, parseSort } from "@/lib/auth/validation";
import type { ExtensionAnalysis } from "@/types/extension";
import type { ExtensionSort } from "@/lib/db/repositories/extensions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hasValidAnalysis(value: unknown): value is ExtensionAnalysis {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExtensionAnalysis>;
  return (
    typeof candidate.metadata === "object" &&
    candidate.metadata !== null &&
    typeof candidate.healthScore === "object" &&
    candidate.healthScore !== null &&
    typeof candidate.manifest === "object" &&
    candidate.manifest !== null
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const url = new URL(request.url);
    const page = parsePagination(url, { page: 1, limit: 12 });
    const sort = parseSort<ExtensionSort>(
      url.searchParams.get("sort"),
      ["newest", "oldest", "name", "health_desc", "health_asc"] as const,
      "newest",
    );
    const data = listExtensions(user.id, {
      page: page.page,
      limit: page.limit,
      search: url.searchParams.get("q") ?? undefined,
      sort,
    });
    return NextResponse.json({
      items: data.items,
      page: page.page,
      limit: page.limit,
      total: data.total,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const plan = getActivePlan();
    const ip = getClientIp(request);
    const authLimit = checkRateLimit(`analysis:${user.id}:${ip}`, 30, 60 * 1000);
    if (!authLimit.ok) throw new ApiError(429, "rate_limited", "Too many analyses. Please wait and try again.");

    if (usageLimitReached(user.id, "analysis", plan.analysisLimit)) {
      throw usageLimit("analysis");
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw badRequest("Expected a JSON analysis payload.");
    }
    if (Number(request.headers.get("content-length") ?? 0) > 12 * 1024 * 1024) {
      throw badRequest("The analysis payload is too large.");
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !hasValidAnalysis(body.analysis)) {
      throw badRequest("The analysis payload is invalid.");
    }
    const analysis = body.analysis;
    const name = analysis.metadata.name || "Untitled Extension";
    const version = analysis.metadata.version ?? null;
    const manifestVersion = analysis.manifest.manifestVersion ?? null;
    const extensionId = typeof body.extensionId === "string" ? body.extensionId : "";

    let owned = extensionId ? getOwnedExtension(user.id, extensionId) : null;
    if (!owned) {
      owned = createExtension({
        userId: user.id,
        name,
        version,
        manifestVersion,
        sourceName: analysis.sourceName,
        healthScore: analysis.healthScore.total,
      });
    } else {
      updateExtensionFromAnalysis({
        id: owned.id,
        name,
        version,
        manifestVersion,
        healthScore: analysis.healthScore.total,
      });
    }

    const snapshot = createSnapshot({
      extensionId: owned.id,
      healthScore: analysis.healthScore.total,
      manifestVersion,
      analysisJson: JSON.stringify(analysis),
    });
    recordUsage(user.id, "analysis");

    return NextResponse.json(
      {
        extension: { ...owned, analysisCount: 1, testCount: countTestRuns(owned.id), latestAnalysisId: snapshot.id },
        snapshot: { id: snapshot.id, healthScore: snapshot.health_score, createdAt: snapshot.created_at },
      },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) throw badRequest("Extension id is required.");
    const deleted = deleteExtension(user.id, id);
    if (!deleted) throw new ApiError(404, "not_found", "Extension not found.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
