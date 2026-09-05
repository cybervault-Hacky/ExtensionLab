import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { listPackagesForUser, toPackage } from "@/lib/db/repositories/packages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lists the caller's stored packages (metadata only; no storage keys). */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    return NextResponse.json({ items: listPackagesForUser(user.id).map(toPackage) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
