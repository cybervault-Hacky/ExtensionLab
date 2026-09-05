import "server-only";
import { capabilitiesForBrowser } from "./capabilities";
import { ENGINE_LABELS, isBrowserId, type BrowserId, type BrowserProfile, type PublicBrowserInfo } from "./types";

/**
 * Browser runtime registry.
 *
 * Browser versions and images are *deployment configuration*, never guesses:
 * the operator pins what the images ship via BROWSER_*_VERSION / image tags.
 * Every execution records the configured version plus the version detected by
 * the in-container runner at runtime, so reports stay reproducible.
 */

export interface BrowserRegistryConfig {
  /** Server-internal image names per browser. */
  images: Record<BrowserId, string>;
  /** Deployment-configured version labels per browser ("bundled" when image-pinned). */
  versions: Record<BrowserId, string>;
  /** Browser executables inside the container (never exposed to clients). */
  executables: Record<BrowserId, string>;
  enabled: Record<BrowserId, boolean>;
  limits: {
    maxBrowsersPerMatrix: number;
    maxMatrixTests: number;
    maxMatrixConcurrency: number;
    maxMatrixArtifacts: number;
    matrixTimeoutMs: number;
    perBrowserTimeoutMs: number;
  };
}

function imageFor(browserId: BrowserId, explicit: string | undefined, fallback: string): string {
  const trimmed = explicit?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function getBrowserRegistryConfig(): BrowserRegistryConfig {
  const version = (id: BrowserId, fallback: string): string => {
    const raw = process.env[`BROWSER_${id.toUpperCase()}_VERSION`]?.trim();
    return raw && raw.length > 0 ? raw : fallback;
  };
  const enabled = (id: BrowserId, fallback: boolean): boolean => {
    const raw = process.env[`BROWSER_${id.toUpperCase()}_ENABLED`]?.trim().toLowerCase();
    if (!raw) return fallback;
    return raw === "1" || raw === "true";
  };
  const chromiumImage = process.env.SANDBOX_IMAGE?.trim() || "extensionlab-sandbox:local";
  const numberEnv = (name: string, fallback: number, min: number, max: number): number => {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    images: {
      chromium: imageFor("chromium", process.env.SANDBOX_IMAGE_CHROMIUM?.trim(), chromiumImage),
      edge: imageFor("edge", process.env.SANDBOX_IMAGE_EDGE?.trim(), "extensionlab-sandbox-edge:local"),
      firefox: imageFor("firefox", process.env.SANDBOX_IMAGE_FIREFOX?.trim(), "extensionlab-sandbox-firefox:local"),
    },
    versions: {
      chromium: version("chromium", "bundled"),
      edge: version("edge", "bundled"),
      firefox: version("firefox", "bundled"),
    },
    executables: {
      chromium: process.env.BROWSER_CHROMIUM_EXECUTABLE?.trim() || "chromium",
      edge: process.env.BROWSER_EDGE_EXECUTABLE?.trim() || "microsoft-edge",
      firefox: process.env.BROWSER_FIREFOX_EXECUTABLE?.trim() || "firefox",
    },
    enabled: {
      chromium: enabled("chromium", true),
      edge: enabled("edge", true),
      firefox: enabled("firefox", true),
    },
    limits: {
      maxBrowsersPerMatrix: numberEnv("MAX_BROWSERS_PER_MATRIX", 3, 1, 3),
      maxMatrixTests: numberEnv("MAX_MATRIX_TESTS", 32, 1, 64),
      maxMatrixConcurrency: numberEnv("MAX_MATRIX_CONCURRENCY", 2, 1, 16),
      maxMatrixArtifacts: numberEnv("MAX_MATRIX_ARTIFACTS", 24, 1, 64),
      matrixTimeoutMs: numberEnv("MATRIX_TIMEOUT_MS", 8 * 60 * 1000, 30_000, 60 * 60 * 1000),
      perBrowserTimeoutMs: numberEnv("MATRIX_BROWSER_TIMEOUT_MS", 150 * 1000, 10_000, 30 * 60 * 1000),
    },
  };
}

export function listBrowserProfiles(): BrowserProfile[] {
  const config = getBrowserRegistryConfig();
  return (["chromium", "edge", "firefox"] as BrowserId[]).map((browserId) =>
    profileFor(browserId, config),
  );
}

export function getBrowserProfile(browserId: BrowserId): BrowserProfile {
  return profileFor(browserId, getBrowserRegistryConfig());
}

function profileFor(browserId: BrowserId, config: BrowserRegistryConfig): BrowserProfile {
  const engine = browserId === "firefox" ? "gecko" : "chromium";
  const displayName =
    browserId === "chromium" ? "Chromium" : browserId === "edge" ? "Microsoft Edge" : "Firefox";
  return {
    browserId,
    displayName,
    engine,
    engineLabel:
      browserId === "edge" ? "Chromium engine (Edge)" : ENGINE_LABELS[engine],
    version: config.versions[browserId],
    enabled: config.enabled[browserId],
    containerImage: config.images[browserId],
    executable: config.executables[browserId],
    extensionFormat: browserId === "firefox" ? "temporary-addon" : "command-line-flag",
    capabilities: capabilitiesForBrowser(browserId),
    defaultTimeouts: {
      startupMs: browserId === "firefox" ? 45_000 : 30_000,
      commandMs: 8_000,
      executionMs: config.limits.perBrowserTimeoutMs,
    },
  };
}

export function browserEngineLabel(browserId: BrowserId): string {
  return getBrowserProfile(browserId).engineLabel;
}

/** Resolves a validated browser id or null (callers must reject unknown ids). */
export function resolveBrowserId(value: unknown): BrowserId | null {
  return isBrowserId(value) ? value : null;
}

/** Image used by the Docker driver for a browser execution (server-internal). */
export function containerImageForBrowser(browserId: BrowserId): string {
  return getBrowserRegistryConfig().images[browserId];
}
