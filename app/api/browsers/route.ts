import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { listBrowserProfiles } from "@/lib/browsers/registry";
import { getBrowserRuntimesHealth } from "@/lib/browsers/availability";
import { toPublicBrowser } from "@/lib/browsers/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe public browser information: id, display name, engine, version label,
 * availability and capability summary. Container images, executables, host
 * details and Docker information are never returned.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireApiUser(request);
    const health = await getBrowserRuntimesHealth();
    const browsers = listBrowserProfiles().map((profile) => toPublicBrowser(profile, health[profile.browserId]));
    return NextResponse.json({ browsers });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
