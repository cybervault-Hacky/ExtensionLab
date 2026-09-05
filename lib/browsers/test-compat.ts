import type { AssertionType, TestActionType } from "@/lib/testing/types";
import { capabilityUsable } from "./capabilities";
import type { BrowserCapabilities, BrowserCapabilityId, BrowserId, BrowserProfile } from "./types";

/**
 * Capability gating for the deterministic test engine.
 *
 * An assertion or action that depends on a capability the configured browser
 * runtime does not support is reported as SKIPPED / UNSUPPORTED — never as a
 * failure of the extension. Only hard "unsupported" verdicts gate execution;
 * "partial" and "version-dependent" capabilities stay executable so real
 * browser differences surface as evidence instead of being silently skipped.
 */

export const ASSERTION_REQUIRED_CAPABILITIES: Record<AssertionType, readonly BrowserCapabilityId[]> = {
  element_exists: [],
  element_visible: [],
  text_contains: [],
  url_equals: [],
  url_contains: [],
  console_contains: ["consoleEvents"],
  console_not_contains: ["consoleEvents"],
  network_request_seen: ["networkEvents"],
  network_status_equals: ["networkStatusCodes"],
  extension_loaded: [],
  content_script_detected: ["contentScripts"],
  service_worker_detected: ["serviceWorker"],
  popup_available: ["popup"],
  runtime_error_none: ["consoleEvents"],
  network_4xx_none: ["networkStatusCodes"],
  network_5xx_none: ["networkStatusCodes"],
};

export const ACTION_REQUIRED_CAPABILITIES: Record<TestActionType, readonly BrowserCapabilityId[]> = {
  open_url: [],
  reload_page: [],
  wait: [],
  click: [],
  type: [],
  select: [],
  scroll: [],
  inspect_text: [],
  inspect_element: [],
  open_popup: ["popup"],
  clear_console: [],
  capture_screenshot: ["screenshots"],
};

/** Returns the capability ids (of `required`) that the browser does not support. */
export function unsupportedCapabilities(
  capabilities: BrowserCapabilities,
  required: readonly BrowserCapabilityId[],
): BrowserCapabilityId[] {
  return required.filter((id) => !capabilityUsable(capabilities[id]));
}

export function isAssertionSupported(
  profile: BrowserProfile,
  assertionType: AssertionType,
): { supported: boolean; unsupported: BrowserCapabilityId[] } {
  const unsupported = unsupportedCapabilities(
    profile.capabilities,
    ASSERTION_REQUIRED_CAPABILITIES[assertionType] ?? [],
  );
  return { supported: unsupported.length === 0, unsupported };
}

export function isActionSupported(
  profile: BrowserProfile,
  actionType: TestActionType,
): { supported: boolean; unsupported: BrowserCapabilityId[] } {
  const unsupported = unsupportedCapabilities(
    profile.capabilities,
    ACTION_REQUIRED_CAPABILITIES[actionType] ?? [],
  );
  return { supported: unsupported.length === 0, unsupported };
}

/**
 * Static applicability: tests whose *subject* cannot exist in a browser are
 * skipped before execution (e.g. a service-worker lifecycle test on Gecko,
 * where MV3 background execution uses an event page by design).
 */
export function staticallySkippedTestsForBrowser(
  profile: BrowserProfile,
  discovery: { manifestVersion: "v2" | "v3" | "unknown"; hasServiceWorker: boolean },
): Array<{ reason: string; applies: (testId: string) => boolean }> {
  const rules: Array<{ reason: string; applies: (testId: string) => boolean }> = [];
  if (
    profile.browserId === "firefox" &&
    discovery.manifestVersion === "v3" &&
    discovery.hasServiceWorker
  ) {
    rules.push({
      reason:
        "Firefox runs MV3 background execution as an event page rather than a service worker; service-worker lifecycle evidence is not expected on this engine.",
      applies: (testId) => testId === "service-worker",
    });
  }
  return rules;
}

export type { BrowserId };
