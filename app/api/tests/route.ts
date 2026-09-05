import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { listTestRuns, toTestRunListItem } from "@/lib/db/repositories/test-runs";
import type { TestRunFilter } from "@/lib/db/repositories/test-runs";
import { parsePagination } from "@/lib/auth/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const url = new URL(request.url);
    const page = parsePagination(url, { page: 1, limit: 12 });
    const rawFilter = url.searchParams.get("status") ?? "all";
    const filter: TestRunFilter = ["all", "passed", "failed", "warnings", "running", "cancelled"].includes(rawFilter)
      ? (rawFilter as TestRunFilter)
      : "all";
    const browserParam = url.searchParams.get("browser");
    const matrixParam = url.searchParams.get("matrixRunId");
    const data = listTestRuns(user.id, {
      page: page.page,
      limit: page.limit,
      filter,
      search: url.searchParams.get("q") ?? undefined,
      browserId: browserParam && ["chromium", "edge", "firefox"].includes(browserParam) ? browserParam : undefined,
      matrixRunId: matrixParam && /^[\w-]+$/.test(matrixParam) ? matrixParam : undefined,
    });
    return NextResponse.json({
      items: data.items.map(toTestRunListItem),
      page: page.page,
      limit: page.limit,
      total: data.total,
      filter,
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
