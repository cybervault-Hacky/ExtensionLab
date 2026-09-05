import type {
  BrowserCapabilities,
  BrowserCapabilityId,
  BrowserId,
  CapabilityInfo,
  CapabilitySupport,
} from "./types";

/**
 * Capability metadata for the configured runtime.
 *
 * Rules are conservative and evidence-based:
 * - Chromium/Edge share the Chromium engine and therefore the extension
 *   platform: MV3, service workers, CDP-based console/network diagnostics.
 *   MV2 support is version-dependent (Chromium began phasing MV2 out; the
 *   Debian-pinned builds used by the runtime images still load it), so it is
 *   reported as "version-dependent" rather than claimed supported or removed.
 * - Firefox (Gecko) supports MV2 and MV3, but MV3 background execution uses an
 *   event page (non-persistent background script), not a service worker —
 *   documented as a different model, never as a defect.
 * - Firefox network diagnostics in this runtime observe requests, but response
 *   status codes are not guaranteed for every request; assertions that require
 *   statuses are capability-gated to SKIPPED/UNSUPPORTED instead of failing.
 */

function cap(id: BrowserCapabilityId, support: CapabilitySupport, note?: string): CapabilityInfo {
  return note ? { id, support, note } : { id, support };
}

function chromiumCaps(): BrowserCapabilities {
  return {
    extensionManifestV2: cap(
      "extensionManifestV2",
      "version-dependent",
      "Manifest V2 is being phased out of Chromium-based browsers; support depends on the pinned browser version.",
    ),
    extensionManifestV3: cap("extensionManifestV3", "supported"),
    serviceWorker: cap("serviceWorker", "supported"),
    backgroundPage: cap(
      "backgroundPage",
      "version-dependent",
      "Background pages require Manifest V2, whose availability depends on the pinned browser version.",
    ),
    popup: cap("popup", "supported"),
    contentScripts: cap("contentScripts", "supported"),
    screenshots: cap("screenshots", "supported"),
    consoleEvents: cap("consoleEvents", "supported"),
    networkEvents: cap("networkEvents", "supported"),
    networkStatusCodes: cap("networkStatusCodes", "supported"),
    extensionReload: cap("extensionReload", "supported"),
    runtimeMessaging: cap("runtimeMessaging", "supported"),
  };
}

function firefoxCaps(): BrowserCapabilities {
  return {
    extensionManifestV2: cap("extensionManifestV2", "supported"),
    extensionManifestV3: cap("extensionManifestV3", "supported"),
    serviceWorker: cap(
      "serviceWorker",
      "partial",
      "Firefox MV3 extensions use a non-persistent event page instead of a service worker; worker lifecycle evidence differs by design.",
    ),
    backgroundPage: cap(
      "backgroundPage",
      "supported",
      "Firefox continues to support non-persistent background scripts (event pages).",
    ),
    popup: cap("popup", "supported"),
    contentScripts: cap("contentScripts", "supported"),
    screenshots: cap("screenshots", "supported"),
    consoleEvents: cap("consoleEvents", "supported"),
    networkEvents: cap(
      "networkEvents",
      "partial",
      "Request URLs and timings are observed via the automation protocol; per-response status codes may be unavailable.",
    ),
    networkStatusCodes: cap(
      "networkStatusCodes",
      "unsupported",
      "Response status codes are not reliably reported by this Firefox automation runtime.",
    ),
    extensionReload: cap(
      "extensionReload",
      "unsupported",
      "Temporary add-on restart is not exposed by this runtime; extensions are loaded once per disposable browser.",
    ),
    runtimeMessaging: cap(
      "runtimeMessaging",
      "partial",
      "Extension messaging is not instrumented in this Firefox runtime.",
    ),
  };
}

export function capabilitiesForBrowser(browserId: BrowserId): BrowserCapabilities {
  switch (browserId) {
    case "chromium":
    case "edge":
      return chromiumCaps();
    case "firefox":
      return firefoxCaps();
  }
}

export function capabilitySupport(
  capabilities: BrowserCapabilities,
  id: BrowserCapabilityId,
): CapabilityInfo {
  return capabilities[id];
}

/** True when the capability can be exercised at all (supported or partial). */
export function capabilityUsable(capability: CapabilityInfo): boolean {
  return capability.support === "supported" || capability.support === "partial";
}
