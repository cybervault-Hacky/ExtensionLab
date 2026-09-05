import type { ExtensionAnalysis, ManifestSummary, PermissionsAnalysis } from "@/types/extension";
import type { BrowserId } from "@/lib/browsers/types";

/**
 * Phase 9 static browser-compatibility analysis.
 *
 * Rules are deliberately conservative and capability-backed: only documented,
 * well-known behavioral differences produce notes. A static note is never a
 * verdict about a real failure — runtime results from cross-browser tests stay
 * authoritative. The analysis is informational; it is never used to classify
 * an extension as malicious or broken.
 */

export interface BrowserCompatNote {
  id: string;
  severity: "info" | "warning";
  browsers: BrowserId[];
  title: string;
  detail: string;
}

export interface BrowserCompatVerdict {
  browserId: BrowserId;
  /** "review" means "static analysis found browser-specific considerations". */
  verdict: "supported" | "review";
  summary: string;
  noteIds: string[];
}

export interface BrowserApiUsage {
  namespace: "chrome" | "browser";
  apis: string[];
  fileCount: number;
  files: string[];
}

export interface BrowserPolyfill {
  name: string;
  evidence: string;
  note: string;
}

export interface BrowserCompatibilityAnalysis {
  perBrowser: BrowserCompatVerdict[];
  notes: BrowserCompatNote[];
  apiUsage: BrowserApiUsage[];
  polyfills: BrowserPolyfill[];
  basis: string;
}

/** Chromium-only permissions with documented absence in Firefox (keep short and factual). */
const CHROMIUM_ONLY_PERMISSIONS = new Set(["offscreen", "sidePanel"]);

/** Permissions whose Firefox behavior is documented as partial. */
const FIREFOX_PARTIAL_PERMISSIONS = new Set(["declarativeNetRequest"]);

interface CompatInput {
  manifest: ManifestSummary;
  manifestRaw: Record<string, unknown>;
  permissions: PermissionsAnalysis;
  /** Reads a source file's text for API/polyfill scanning (already size-capped upstream). */
  readSource: (path: string) => Promise<string | null>;
  sourcePaths: string[];
}

export async function analyzeBrowserCompatibility(input: CompatInput): Promise<BrowserCompatibilityAnalysis> {
  const notes: BrowserCompatNote[] = [];
  const manifestVersion = input.manifest.manifestVersion;
  const background = (input.manifestRaw.background ?? null) as Record<string, unknown> | null;
  const hasServiceWorker = Boolean(background && "service_worker" in background);
  const hasBackgroundPage =
    Boolean(background && "page" in background) || Boolean(background && Array.isArray(background.scripts));
  const browserSpecificSettings = (input.manifestRaw.browser_specific_settings ?? null) as
    | { gecko?: { id?: string; strict_min_version?: string } }
    | null;
  const hostPermissions = input.permissions.hostPermissions;

  if (manifestVersion === "v2") {
    notes.push({
      id: "manifest-v2-chromium-phaseout",
      severity: "info",
      browsers: ["chromium", "edge"],
      title: "Manifest V2 support is version-dependent in Chromium browsers",
      detail:
        "Chromium-based browsers are phasing out Manifest V2. Whether this extension loads depends on the pinned browser version of the runtime; Firefox continues to support Manifest V2.",
    });
  }

  if (manifestVersion === "v3" && hasServiceWorker) {
    notes.push({
      id: "mv3-background-model-gecko",
      severity: "info",
      browsers: ["firefox"],
      title: "Background execution model differs on Firefox",
      detail:
        "Firefox implements Manifest V3 background execution as a non-persistent event page, not a service worker. The extension still loads, but service-worker lifecycle behavior will differ. Firefox supports background.scripts in Manifest V3 for this model.",
    });
  }

  if (manifestVersion === "v2" && hasBackgroundPage) {
    notes.push({
      id: "background-page-model",
      severity: "info",
      browsers: ["chromium", "edge"],
      title: "Background pages follow Manifest V2 availability",
      detail:
        "Background pages require Manifest V2; their availability in Chromium-based browsers follows the Manifest V2 phase-out timeline of the pinned browser version. Firefox supports non-persistent background scripts (event pages).",
    });
  }

  if (manifestVersion === "v3" && hostPermissions.length > 0) {
    notes.push({
      id: "host-permissions-gecko",
      severity: "info",
      browsers: ["firefox"],
      title: "Host permissions are user-managed on Firefox",
      detail:
        "Firefox treats Manifest V3 host_permissions as grants the user can revoke or delay; do not assume host access is present at install time. Chromium grants them at install (subject to runtime warnings).",
    });
  }

  if (browserSpecificSettings?.gecko) {
    notes.push({
      id: "firefox-specific-settings",
      severity: "info",
      browsers: ["firefox"],
      title: "Firefox-specific manifest settings present",
      detail: `browser_specific_settings.gecko is declared${browserSpecificSettings.gecko.id ? ` (id ${browserSpecificSettings.gecko.id})` : ""}${browserSpecificSettings.gecko.strict_min_version ? ` with strict_min_version ${browserSpecificSettings.gecko.strict_min_version}` : ""}. This explicitly targets Firefox.`,
    });
  }

  for (const permission of input.permissions.permissions) {
    if (CHROMIUM_ONLY_PERMISSIONS.has(permission)) {
      notes.push({
        id: `permission-chromium-only-${permission}`,
        severity: "warning",
        browsers: ["firefox"],
        title: `Permission "${permission}" is Chromium-only`,
        detail: `The "${permission}" permission is not available in Firefox. Code paths using it will not work there; guard or feature-detect before use.`,
      });
    } else if (FIREFOX_PARTIAL_PERMISSIONS.has(permission)) {
      notes.push({
        id: `permission-partial-${permission}`,
        severity: "info",
        browsers: ["firefox"],
        title: `Permission "${permission}" behaves differently on Firefox`,
        detail: `Firefox supports "${permission}", but its behavior and availability differ from Chromium (introduced in Firefox 113; verify against your minimum Firefox version).`,
      });
    }
  }

  // ---------------------------------------------------------------- scanning
  const apiUsage: BrowserApiUsage[] = [];
  const polyfills: BrowserPolyfill[] = [];
  const chromeApis = new Map<string, Set<string>>();
  const browserApis = new Map<string, Set<string>>();
  let polyfillDetected = false;

  const jsFiles = input.sourcePaths.filter((path) => /\.(js|mjs|cjs)$/i.test(path)).slice(0, 120);
  for (const path of jsFiles) {
    const content = await input.readSource(path);
    if (!content) continue;
    scanNamespace(content, "chrome", path, chromeApis);
    scanNamespace(content, "browser", path, browserApis);
    if (!polyfillDetected && /webextension-polyfill|browser-polyfill/i.test(content)) {
      polyfillDetected = true;
      polyfills.push({
        name: "webextension-polyfill",
        evidence: path,
        note: "A browser API abstraction/polyfill appears to be bundled. This is a common, legitimate compatibility helper for the chrome.*/browser.* namespace difference; informational only.",
      });
    }
  }

  if (chromeApis.size > 0) {
    apiUsage.push(toApiUsage("chrome", chromeApis));
    if (browserSpecificSettings?.gecko || browserApis.size > 0) {
      // Firefox supports the chrome.* namespace for most APIs; informational only.
    }
  }
  if (browserApis.size > 0) {
    apiUsage.push(toApiUsage("browser", browserApis));
    notes.push({
      id: "browser-namespace-chromium",
      severity: "info",
      browsers: ["chromium", "edge"],
      title: "browser.* namespace detected",
      detail:
        "The code uses the browser.* namespace, which Firefox provides natively but Chrome and Edge do not without a polyfill. Namespace preference alone is not an incompatibility — Firefox also supports chrome.* for most APIs.",
    });
  }
  if (chromeApis.size > 0 && !browserSpecificSettings?.gecko && browserApis.size === 0) {
    notes.push({
      id: "no-firefox-targeting",
      severity: "info",
      browsers: ["firefox"],
      title: "No Firefox-specific manifest settings",
      detail:
        "The manifest does not declare browser_specific_settings.gecko. Firefox can still load many extensions without it, but distribution through addons.mozilla.org requires it.",
    });
  }

  // ---------------------------------------------------------------- verdicts
  const perBrowser: BrowserCompatVerdict[] = (["chromium", "edge", "firefox"] as BrowserId[]).map((browserId) => {
    const applicable = notes.filter((note) => note.browsers.includes(browserId));
    const hasWarning = applicable.some((note) => note.severity === "warning");
    return {
      browserId,
      verdict: applicable.length > 0 ? "review" : "supported",
      summary:
        applicable.length === 0
          ? "No browser-specific considerations detected by static analysis."
          : hasWarning
            ? "Review required: static analysis found browser-specific considerations."
            : "Supported with notes: static analysis found browser-specific behavior to be aware of.",
      noteIds: applicable.map((note) => note.id),
    };
  });

  return {
    perBrowser,
    notes,
    apiUsage,
    polyfills,
    basis:
      "Static compatibility notes based on documented browser capabilities and this deployment's pinned runtime versions. They are informational: verified cross-browser results from real executions remain authoritative.",
  };
}

function scanNamespace(content: string, namespace: "chrome" | "browser", path: string, sink: Map<string, Set<string>>): void {
  const pattern = new RegExp(`\\b${namespace}\\.([A-Za-z][A-Za-z0-9]*)`, "g");
  let match: RegExpExecArray | null;
  let hits = 0;
  while ((match = pattern.exec(content)) !== null && hits < 40) {
    const api = match[1];
    if (["runtime", "storage", "tabs", "scripting", "action", "i18n", "webRequest", "declarativeNetRequest", "notifications", "alarms", "identity", "cookies", "menus", "commands", "downloads", "windows", "sidePanel", "offscreen"].includes(api) || sink.size < 12) {
      const files = sink.get(`${namespace}.${api}`) ?? new Set<string>();
      if (files.size < 8) files.add(path);
      sink.set(`${namespace}.${api}`, files);
      hits += 1;
    }
  }
}

function toApiUsage(namespace: "chrome" | "browser", apis: Map<string, Set<string>>): BrowserApiUsage {
  const entries = [...apis.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return {
    namespace,
    apis: entries.map(([api]) => api),
    fileCount: new Set(entries.flatMap(([, files]) => [...files])).size,
    files: [...new Set(entries.flatMap(([, files]) => [...files]))].slice(0, 10),
  };
}

/** Report projection: static compatibility section (distinct from runtime results). */
export function browserCompatForReport(analysis: ExtensionAnalysis): BrowserCompatibilityAnalysis | null {
  return analysis.browserCompatibility ?? null;
}
