import { ExtensionLabError } from "./errors";
import {
  type ManifestFeatures,
  type ManifestSummary,
  type ManifestVersionKey,
  type ManifestVersionLabel,
} from "@/types/extension";

export type ReferencedCategory = "structure" | "assets" | "configuration";

export interface ReferencedResource {
  field: string;
  path: string;
  category: ReferencedCategory;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function detailFor(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join(", ");
  }
  return String(value);
}

export function getManifestVersionKey(
  manifestVersion: unknown,
): ManifestVersionKey {
  if (manifestVersion === 3) return "v3";
  if (manifestVersion === 2) return "v2";
  return "unknown";
}

export function getManifestVersionLabel(value: unknown): ManifestVersionLabel {
  switch (getManifestVersionKey(value)) {
    case "v3":
      return "Manifest V3";
    case "v2":
      return "Manifest V2";
    default:
      return "Unknown";
  }
}

export function getManifestVersionBadge(value: unknown): string {
  switch (getManifestVersionKey(value)) {
    case "v3":
      return "V3";
    case "v2":
      return "V2";
    default:
      return "?";
  }
}

/**
 * Parse and validate manifest JSON.
 *
 * The JSON is treated as untrusted data. It is parsed into a plain object and
 * never evaluated or rendered as HTML.
 */
export function parseManifestJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Manifest root must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ExtensionLabError(
      "manifest-invalid",
      "This manifest could not be parsed as valid JSON.",
      error instanceof Error ? error.message : "Invalid JSON content.",
    );
  }
}

/**
 * Build a summary describing the manifest. Only present fields are surfaced.
 */
export function describeManifest(raw: Record<string, unknown>): ManifestSummary {
  const features: ManifestFeatures = {
    action: raw.action !== undefined,
    browser_action: raw.browser_action !== undefined,
    page_action: raw.page_action !== undefined,
    background: raw.background !== undefined,
    content_scripts:
      Array.isArray(raw.content_scripts) && raw.content_scripts.length > 0,
    permissions: Array.isArray(raw.permissions) && raw.permissions.length > 0,
    host_permissions:
      Array.isArray(raw.host_permissions) && raw.host_permissions.length > 0,
    optional_permissions:
      Array.isArray(raw.optional_permissions) &&
      raw.optional_permissions.length > 0,
    icons: Object.keys(asObject(raw.icons) ?? {}).length > 0,
    options_page: asString(raw.options_page) !== undefined,
    options_ui: asObject(raw.options_ui) !== undefined,
    web_accessible_resources: Array.isArray(raw.web_accessible_resources),
    commands: Object.keys(asObject(raw.commands) ?? {}).length > 0,
    content_security_policy:
      asString(raw.content_security_policy) !== undefined ||
      asObject(raw.content_security_policy) !== undefined,
  };

  const knownFields = [
    "name",
    "version",
    "description",
    "manifest_version",
    "action",
    "browser_action",
    "page_action",
    "background",
    "content_scripts",
    "permissions",
    "host_permissions",
    "optional_permissions",
    "icons",
    "options_page",
    "options_ui",
    "web_accessible_resources",
    "commands",
    "content_security_policy",
  ];

  const presentFields = knownFields.filter((field) => raw[field] !== undefined);

  return {
    name: asString(raw.name),
    version: asString(raw.version),
    description: asString(raw.description),
    manifestVersion: getManifestVersionKey(raw.manifest_version),
    manifestVersionLabel: getManifestVersionLabel(raw.manifest_version),
    raw,
    presentFields,
    features,
    detectedConfig: buildDetectedConfig(raw),
  };
}

function buildDetectedConfig(
  raw: Record<string, unknown>,
): ManifestSummary["detectedConfig"] {
  const items: ManifestSummary["detectedConfig"] = [];

  const action = asObject(raw.action) ?? asObject(raw.browser_action);
  const popup = asString(action?.default_popup);
  items.push({
    label: "Action / Popup",
    detail: popup ? `default_popup: ${popup}` : action ? "Action defined" : "Not defined",
    present: action !== undefined,
  });

  const background = asObject(raw.background);
  const serviceWorker = asString(background?.service_worker);
  const scripts = asStringArray(background?.scripts);
  const backgroundPage = asString(background?.page);
  items.push({
    label: "Background",
    detail: serviceWorker
      ? `service_worker: ${serviceWorker}`
      : scripts.length > 0
        ? `scripts: ${scripts.join(", ")}`
        : backgroundPage
          ? `page: ${backgroundPage}`
          : background
            ? "Background defined"
            : "Not defined",
    present: background !== undefined,
  });

  const contentScripts = Array.isArray(raw.content_scripts)
    ? (raw.content_scripts as Array<Record<string, unknown>>)
    : [];
  const scriptCount = contentScripts.reduce((count, script) => {
    const js = asStringArray(script?.js);
    return count + js.length;
  }, 0);
  items.push({
    label: "Content scripts",
    detail:
      contentScripts.length > 0
        ? `${contentScripts.length} script group${contentScripts.length === 1 ? "" : "s"} (${scriptCount} files)`
        : "Not defined",
    present: contentScripts.length > 0,
  });

  const optionsPage = asString(raw.options_page);
  const optionsUi = asObject(raw.options_ui);
  items.push({
    label: "Options page",
    detail: optionsPage ?? asString(optionsUi?.page) ?? "Not defined",
    present: optionsPage !== undefined || optionsUi !== undefined,
  });

  const icons = asObject(raw.icons);
  items.push({
    label: "Icons",
    detail: icons ? `${Object.keys(icons).length} icon${Object.keys(icons).length === 1 ? "" : "s"}` : "Not defined",
    present: icons !== undefined,
  });

  const commands = asObject(raw.commands);
  items.push({
    label: "Commands",
    detail: commands ? `${Object.keys(commands).length} command${Object.keys(commands).length === 1 ? "" : "s"}` : "Not defined",
    present: commands !== undefined,
  });

  const csp = raw.content_security_policy;
  items.push({
    label: "Content Security Policy",
    detail: csp ? `${detailFor(csp).slice(0, 80)}` : "Not defined",
    present: csp !== undefined,
  });

  const war = raw.web_accessible_resources;
  items.push({
    label: "Web accessible resources",
    detail: Array.isArray(war) ? `${war.length} resource group${war.length === 1 ? "" : "s"}` : "Not defined",
    present: Array.isArray(war),
  });

  return items;
}

/**
 * Collect file references made by the manifest.
 *
 * Returns raw paths (as they appear in the manifest). The analyzer resolves them
 * against the detected extension root so nested-ZIP packages work correctly.
 */
export function collectReferencedResources(
  raw: Record<string, unknown>,
): ReferencedResource[] {
  const references: ReferencedResource[] = [];

  const add = (field: string, path: string | undefined, category: ReferencedCategory) => {
    if (path) references.push({ field, path, category });
  };

  const action =
    asObject(raw.action) ??
    asObject(raw.browser_action) ??
    asObject(raw.page_action);
  const popup = asString(action?.default_popup);
  add("action.default_popup", popup, "structure");

  const background = asObject(raw.background);
  if (background) {
    add("background.service_worker", asString(background.service_worker), "structure");
    for (const script of asStringArray(background.scripts)) {
      add("background.scripts", script, "structure");
    }
    add("background.page", asString(background.page), "structure");
  }

  if (Array.isArray(raw.content_scripts)) {
    for (const script of raw.content_scripts) {
      const item = asObject(script);
      if (!item) continue;
      for (const js of asStringArray(item.js)) {
        add("content_scripts.js", js, "structure");
      }
      for (const css of asStringArray(item.css)) {
        add("content_scripts.css", css, "assets");
      }
    }
  }

  const icons = asObject(raw.icons);
  if (icons) {
    for (const value of Object.values(icons)) {
      add("icons", asString(value), "assets");
    }
  }

  add("options_page", asString(raw.options_page), "structure");
  const optionsUi = asObject(raw.options_ui);
  add("options_ui.page", asString(optionsUi?.page), "structure");

  const war = raw.web_accessible_resources;
  if (Array.isArray(war)) {
    for (const entry of war) {
      const item = asObject(entry);
      if (item) {
        for (const resource of asStringArray(item.resources)) {
          add("web_accessible_resources", resource, "assets");
        }
      } else if (typeof entry === "string") {
        add("web_accessible_resources", entry, "assets");
      }
    }
  }

  return references;
}
