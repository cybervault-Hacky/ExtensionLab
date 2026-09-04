import type {
  PermissionInfo,
  PermissionsAnalysis,
} from "@/types/extension";

const BROAD_HOST_PATTERNS = [
  "<all_urls>",
  "*://*/*",
  "http://*/*",
  "https://*/*",
  "*://*",
];

function isBroadHostPattern(pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  return BROAD_HOST_PATTERNS.some((candidate) => normalized === candidate);
}

function categoryFor(kind: PermissionInfo["kind"]): PermissionInfo["category"] {
  return kind === "host_permission" ? "host" : "browser";
}

function buildPermissionInfo(
  name: string,
  kind: PermissionInfo["kind"],
  sourceField: PermissionInfo["sourceField"],
): PermissionInfo {
  const isHost = kind === "host_permission";
  const broad = isHost && isBroadHostPattern(name);
  return {
    name,
    kind,
    category: categoryFor(kind),
    sourceField,
    broad,
    reason: broad
      ? "This pattern grants access across a very broad set of origins."
      : undefined,
  };
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).filter(Boolean).sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Extract and categorize permissions from a parsed manifest.
 *
 * We deliberately avoid security verdicts like "safe" or "unsafe". Broad host
 * access is flagged for review only.
 */
export function analyzePermissions(
  raw: Record<string, unknown>,
): PermissionsAnalysis {
  const permissions = sortedUnique(
    Array.isArray(raw.permissions) ? raw.permissions.filter((item): item is string => typeof item === "string") : [],
  );
  const hostPermissions = sortedUnique(
    Array.isArray(raw.host_permissions)
      ? raw.host_permissions.filter((item): item is string => typeof item === "string")
      : [],
  );
  const optionalPermissions = sortedUnique(
    Array.isArray(raw.optional_permissions)
      ? raw.optional_permissions.filter((item): item is string => typeof item === "string")
      : [],
  );

  const categorized: PermissionInfo[] = [
    ...permissions.map((name) => buildPermissionInfo(name, "permission", "permissions")),
    ...hostPermissions.map((name) =>
      buildPermissionInfo(name, "host_permission", "host_permissions"),
    ),
    ...optionalPermissions.map((name) =>
      buildPermissionInfo(name, "optional_permission", "optional_permissions"),
    ),
  ];

  const broadEntries = categorized
    .filter((entry) => entry.kind === "host_permission" && entry.broad)
    .map((entry) => entry.name);

  return {
    permissions,
    hostPermissions,
    optionalPermissions,
    categorized,
    broadPermissions: broadEntries.length > 0,
    note: broadEntries.length > 0
      ? "Broad host access was requested. Review recommended."
      : undefined,
  };
}
