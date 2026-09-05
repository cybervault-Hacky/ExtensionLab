import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness: the process is up and can serve requests. No dependencies are checked. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { status: "ok", service: "extensionlab-web", time: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
