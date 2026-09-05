import { NextResponse } from "next/server";
import { collectReadiness } from "@/lib/observability/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness: 200 when the core dependencies (database, storage) work —
 * automated testing may still be reported as unavailable — and 503 when the
 * service cannot serve requests. The response never contains secrets,
 * hostnames, worker ids or filesystem paths.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const report = await collectReadiness();
    return NextResponse.json(report, {
      status: report.status === "unavailable" ? 503 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { status: "unavailable", time: new Date().toISOString() },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
