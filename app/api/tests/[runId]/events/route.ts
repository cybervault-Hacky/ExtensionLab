import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSandboxToken } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { listRunEvents, resolveAccessibleRun } from "@/lib/testing/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { runId } = await context.params;
    if (!isSafeId(runId)) throw new AppError("NOT_FOUND", { message: "Test run was not found." });
    const run = resolveAccessibleRun(user.id, runId, getSandboxToken(request));
    const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
    const events = listRunEvents(run, Number.isFinite(after) && after > 0 ? after : 0);
    return NextResponse.json(
      { events: events.map((event) => event.payload), lastEventId: events.at(-1)?.id ?? after },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
