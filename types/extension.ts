/**
 * Shared types for the ExtensionLab analyzer.
 *
 * These types describe the fully type-safe result of analyzing a browser
 * extension ZIP package entirely in the browser (Phase 1).
 */

import type { ExtensionLabError } from "@/lib/extension/errors";

export type StatusKind = "passed" | "warning" | "failed" | "info";

export type CategoryKey =
  | "manifest"
  | "structure"
  | "configuration"
  | "permissions"
  | "assets";

export type ManifestVersionLabel = "Manifest V3" | "Manifest V2" | "Unknown";
export type ManifestVersionKey = "v3" | "v2" | "unknown";

export interface AnalyzerIssue {
  id: string;
  severity: StatusKind;
  category: CategoryKey;
  title: string;
  message: string;
}

export interface CategoryScore {
  key: CategoryKey;
  label: string;
  score: number;
  status: StatusKind;
}

export interface HealthScore {
  total: number;
  categories: CategoryScore[];
  basis: string;
}

export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "folder";
  extension: string;
  size: number;
  depth: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  size: number;
  children: FileTreeNode[];
}

export interface ManifestFeatures {
  action: boolean;
  browser_action: boolean;
  page_action: boolean;
  background: boolean;
  content_scripts: boolean;
  permissions: boolean;
  host_permissions: boolean;
  optional_permissions: boolean;
  icons: boolean;
  options_page: boolean;
  options_ui: boolean;
  web_accessible_resources: boolean;
  commands: boolean;
  content_security_policy: boolean;
}

export interface ManifestSummary {
  name?: string;
  version?: string;
  description?: string;
  manifestVersion: ManifestVersionKey;
  manifestVersionLabel: ManifestVersionLabel;
  raw: Record<string, unknown>;
  presentFields: string[];
  features: ManifestFeatures;
  detectedConfig: Array<{
    label: string;
    detail: string;
    present: boolean;
  }>;
}

export type PermissionKind =
  | "permission"
  | "host_permission"
  | "optional_permission";

export interface PermissionInfo {
  name: string;
  kind: PermissionKind;
  category: "browser" | "host";
  sourceField: "permissions" | "host_permissions" | "optional_permissions";
  broad: boolean;
  reason?: string;
}

export interface PermissionsAnalysis {
  permissions: string[];
  hostPermissions: string[];
  optionalPermissions: string[];
  categorized: PermissionInfo[];
  broadPermissions: boolean;
  note?: string;
}

export interface FileStructure {
  entries: FileEntry[];
  tree: FileTreeNode[];
  rootPath: string;
  rootLabel: string;
  totalUncompressedSize: number;
  fileCount: number;
}

export interface ExtensionMetadata {
  name?: string;
  version?: string;
  description?: string;
  manifestVersionLabel: ManifestVersionLabel;
  fileCount: number;
  totalUncompressedSize: number;
}

export interface ExtensionAnalysis {
  createdAt: number;
  sourceName: string;
  sourceSize: number;
  rootPath: string;
  metadata: ExtensionMetadata;
  manifest: ManifestSummary;
  permissions: PermissionsAnalysis;
  files: FileStructure;
  issues: AnalyzerIssue[];
  healthScore: HealthScore;
}

export interface AnalysisStep {
  id: string;
  label: string;
  progress: number;
}

export interface ValidationResult {
  ok: boolean;
  error?: ExtensionLabError;
}
