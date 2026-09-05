import type { BrowserProfile, PublicBrowserInfo } from "./types";
import type { BrowserRuntimeHealth } from "./availability";

/**
 * Client-safe projections of browser profiles.
 *
 * Never include container images, executable names, host information, Docker
 * ids or any internal path. Availability is a boolean plus a stable reason
 * code only.
 */
export function toPublicBrowser(
  profile: BrowserProfile,
  health: BrowserRuntimeHealth | undefined,
): PublicBrowserInfo {
  // A missing health entry is treated as "not available" rather than crashing:
  // the listing route must never 500 because a probe result is absent.
  const safeHealth: BrowserRuntimeHealth = health ?? { browserId: profile.browserId, available: false, reason: "unknown" };
  const view: PublicBrowserInfo = {
    browserId: profile.browserId,
    displayName: profile.displayName,
    engine: profile.engine,
    engineLabel: profile.engineLabel,
    version: profile.version,
    supported: profile.enabled,
    available: profile.enabled && safeHealth.available,
    capabilities: Object.values(profile.capabilities).map((capability) => ({
      id: capability.id,
      support: capability.support,
      ...(capability.note ? { note: capability.note } : {}),
    })),
  };
  if (!view.available) {
    view.unavailableReason = profile.enabled ? safeHealth.reason ?? "image_missing" : "disabled";
  }
  return view;
}
