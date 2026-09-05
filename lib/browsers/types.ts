/**
 * Phase 9 browser model.
 *
 * Strongly typed browser identities, engines and capability metadata. The
 * registry in `lib/browsers/registry.ts` binds these types to deployment
 * configuration (image + version). Internal fields such as container images
 * and executable names never leave the server; only the projections in
 * `lib/browsers/public.ts` are safe for API responses.
 */

export const BROWSER_IDS = ["chromium", "edge", "firefox"] as const;
export type BrowserId = (typeof BROWSER_IDS)[number];

export function isBrowserId(value: unknown): value is BrowserId {
  return typeof value === "string" && (BROWSER_IDS as readonly string[]).includes(value);
}

/**
 * Rendering/automation engine family. Edge is Chromium-compatible: it is built
 * on the Chromium engine, so it shares `engine: "chromium"` and is never
 * presented as a fully independent engine. Firefox runs Gecko.
 */
export type BrowserEngineId = "chromium" | "gecko";

export const ENGINE_LABELS: Record<BrowserEngineId, string> = {
  chromium: "Chromium",
  gecko: "Gecko (Firefox)",
};

/**
 * Capability ids understood by the deterministic test engine. Support values
 * are metadata about the *configured runtime*, derived from the browser and
 * its pinned version — never hardcoded guesses about "latest" browsers.
 */
export const BROWSER_CAPABILITY_IDS = [
  "extensionManifestV2",
  "extensionManifestV3",
  "serviceWorker",
  "backgroundPage",
  "popup",
  "contentScripts",
  "screenshots",
  "consoleEvents",
  "networkEvents",
  "networkStatusCodes",
  "extensionReload",
  "runtimeMessaging",
] as const;
export type BrowserCapabilityId = (typeof BROWSER_CAPABILITY_IDS)[number];

export type CapabilitySupport = "supported" | "partial" | "unsupported" | "version-dependent";

export interface CapabilityInfo {
  id: BrowserCapabilityId;
  support: CapabilitySupport;
  /** Short, factual note explaining a partial/version-dependent verdict. */
  note?: string;
}

export type BrowserCapabilities = Readonly<Record<BrowserCapabilityId, CapabilityInfo>>;

/** How extensions are loaded into the disposable browser instance. */
export type ExtensionLoadMethod = "command-line-flag" | "temporary-addon";

export interface BrowserProfile {
  browserId: BrowserId;
  displayName: string;
  /** Engine family (Edge intentionally shares the Chromium engine). */
  engine: BrowserEngineId;
  /** Human-readable engine label, e.g. "Chromium (Edge)". */
  engineLabel: string;
  /**
   * Version string recorded by deployment configuration. "bundled" means the
   * version is whatever the pinned container image ships; the exact detected
   * version is still captured per execution by the runner.
   */
  version: string;
  /** Whether this browser runtime is enabled in this deployment. */
  enabled: boolean;
  /** Container image used for disposable executions (server-internal). */
  containerImage: string;
  /** Browser executable inside the container (server-internal). */
  executable: string;
  /** How an extension package is loaded into this browser. */
  extensionFormat: ExtensionLoadMethod;
  capabilities: BrowserCapabilities;
  defaultTimeouts: {
    /** Browser startup budget in ms. */
    startupMs: number;
    /** Single command budget in ms. */
    commandMs: number;
    /** Full execution budget in ms. */
    executionMs: number;
  };
}

/** Client-safe browser view: no images, executables, hosts or paths. */
export interface PublicBrowserInfo {
  browserId: BrowserId;
  displayName: string;
  engine: BrowserEngineId;
  engineLabel: string;
  version: string;
  supported: boolean;
  /** True when the browser runtime image is present on this deployment. */
  available: boolean;
  /** Non-availability reason code (stable, non-sensitive). */
  unavailableReason?: "disabled" | "image_missing" | "docker_unavailable" | "unknown";
  capabilities: Array<{
    id: BrowserCapabilityId;
    support: CapabilitySupport;
    note?: string;
  }>;
}
