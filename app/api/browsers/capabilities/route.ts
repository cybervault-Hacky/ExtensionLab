import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { listBrowserProfiles } from "@/lib/browsers/registry";
import { getBrowserRuntimesHealth } from "@/lib/browsers/availability";
import { toPublicBrowser } from "@/lib/browsers/public";
import { ASSERTION_REQUIRED_CAPABILITIES, ACTION_REQUIRED_CAPABILITIES } from "@/lib/browsers/test-compat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Capability matrix across browsers plus the deterministic mapping the test
 * engine uses to gate actions/assertions (unsupported → SKIPPED, never FAIL).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireApiUser(request);
    const health = await getBrowserRuntimesHealth();
    const browsers = listBrowserProfiles().map((profile) => toPublicBrowser(profile, health[profile.browserId]));
    return NextResponse.json({
      browsers,
      capabilityGates: {
        actions: ACTION_REQUIRED_CAPABILITIES,
        assertions: ASSERTION_REQUIRED_CAPABILITIES,
      },
    });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
