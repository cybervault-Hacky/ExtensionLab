import JSZip from "jszip";
import {
  MAX_FILE_COUNT,
  MAX_MANIFEST_SIZE,
  MAX_SINGLE_FILE_SIZE,
  MAX_TOTAL_UNCOMPRESSED_SIZE,
} from "./limits";
import { ExtensionLabError } from "./errors";
import {
  collectReferencedResources,
  describeManifest,
  parseManifestJson,
} from "./manifest";
import { analyzePermissions } from "./permissions";
import type {
  AnalysisStep,
  AnalyzerIssue,
  CategoryKey,
  CategoryScore,
  ExtensionAnalysis,
  FileEntry,
  FileStructure,
  FileTreeNode,
  StatusKind,
} from "@/types/extension";

export const ANALYSIS_STEPS: AnalysisStep[] = [
  { id: "reading", label: "Reading package", progress: 25 },
  { id: "manifest", label: "Checking manifest", progress: 50 },
  { id: "structure", label: "Inspecting structure", progress: 75 },
  { id: "report", label: "Preparing report", progress: 100 },
];

function safeUncompressedSize(entry: JSZip.JSZipObject): number {
  const candidate: unknown = entry;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "_data" in candidate
  ) {
    const data = (candidate as { _data?: { uncompressedSize?: number } })._data;
    if (data && typeof data.uncompressedSize === "number") {
      return data.uncompressedSize;
    }
  }
  return 0;
}

function isDirectoryName(name: string): boolean {
  return name.endsWith("/");
}

function normalizePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
}

function getFileExtension(name: string): string {
  const fileName = name.split("/").pop() ?? name;
  const index = fileName.lastIndexOf(".");
  return index === -1 || index === fileName.length - 1 ? "" : fileName.slice(index + 1).toLowerCase();
}

function buildFileTree(entries: FileEntry[]): FileTreeNode[] {
  const nodeByPath = new Map<string, FileTreeNode>();
  const rootChildren: FileTreeNode[] = [];

  const getOrCreateFolder = (path: string, name: string): FileTreeNode => {
    const existing = nodeByPath.get(path);
    if (existing) return existing;

    const node: FileTreeNode = {
      name,
      path,
      type: "folder",
      size: 0,
      children: [],
    };
    nodeByPath.set(path, node);

    const segments = path.split("/").filter(Boolean);
    if (segments.length === 1) {
      rootChildren.push(node);
    } else {
      const parentPath = segments.slice(0, -1).join("/");
      const parent = getOrCreateFolder(parentPath, segments[segments.length - 2]);
      parent.children.push(node);
    }
    return node;
  };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);

    if (entry.type === "folder") {
      getOrCreateFolder(entry.path, entry.name);
      continue;
    }

    const node: FileTreeNode = {
      name: entry.name,
      path: entry.path,
      type: "file",
      size: entry.size,
      children: [],
    };
    nodeByPath.set(entry.path, node);

    if (segments.length === 1) {
      rootChildren.push(node);
    } else {
      const parentPath = segments.slice(0, -1).join("/");
      const parent = getOrCreateFolder(parentPath, segments[segments.length - 2]);
      parent.children.push(node);
    }
  }

  const computeSize = (node: FileTreeNode): number => {
    if (node.type === "file") return node.size;
    node.size = node.children.reduce((sum, child) => sum + computeSize(child), 0);
    return node.size;
  };

  const sort = (children: FileTreeNode[]): void => {
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of children) sort(child.children);
  };

  for (const child of rootChildren) computeSize(child);
  sort(rootChildren);

  return rootChildren;
}

function findManifestEntry(
  entries: FileEntry[],
): FileEntry | undefined {
  return entries
    .filter((entry) => entry.type === "file" && entry.name === "manifest.json")
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path),
    )[0];
}

function getExtensionRoot(entries: FileEntry[], manifestEntry: FileEntry): string {
  if (manifestEntry.depth === 0) return "";
  return manifestEntry.path.split("/").slice(0, manifestEntry.depth).join("/");
}

function resolveReferencedPath(root: string, referenced: string): string {
  const cleanReferenced = normalizePath(referenced);
  return root ? `${root}/${cleanReferenced}` : cleanReferenced;
}

function buildIssues(
  entries: FileEntry[],
  manifestRaw: ReturnType<typeof describeManifest>["raw"],
  root: string,
): AnalyzerIssue[] {
  const issues: AnalyzerIssue[] = [];

  const fileMap = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.path));

  for (const resource of collectReferencedResources(manifestRaw)) {
    const resolved = resolveReferencedPath(root, resource.path);
    const exists =
      fileMap.has(resolved) ||
      fileMap.has(removeLeadingSlash(resolved));
    if (exists) continue;
    issues.push({
      id: `missing-${resource.category}-${resource.field}`,
      severity: "warning",
      category: resource.category,
      title: "Referenced file not found",
      message: `${resource.field} references "${resource.path}" but the file was not found.`,
    });
  }

  return issues;
}

function removeLeadingSlash(value: string): string {
  return value.replace(/^\//, "");
}

function categorizeSeverityForCategory(
  category: CategoryKey,
  score: number,
): StatusKind {
  if (score >= 94) return "passed";
  if (score >= 80) return "info";
  return "warning";
}

function buildCategoryScores(
  issues: AnalyzerIssue[],
  manifestVersion: ExtensionAnalysis["manifest"]["manifestVersion"],
): CategoryScore[] {
  const counts = issues.reduce<Record<CategoryKey, number>>(
    (acc, issue) => {
      acc[issue.category] += 1;
      return acc;
    },
    { manifest: 0, structure: 0, configuration: 0, permissions: 0, assets: 0 },
  );

  const manifestScore =
    manifestVersion === "unknown" ? 55 : counts.manifest > 0 ? 70 : 100;

  const structureScore = Math.max(0, 100 - counts.structure * 8);
  const configScore = Math.max(0, 100 - counts.configuration * 8);
  const permissionScore = Math.max(0, 100 - counts.permissions * 8);
  const assetsScore = Math.max(0, 100 - counts.assets * 8);

  return [
    { key: "manifest", label: "Manifest", score: manifestScore, status: categorizeSeverityForCategory("manifest", manifestScore) },
    { key: "structure", label: "Structure", score: structureScore, status: categorizeSeverityForCategory("structure", structureScore) },
    { key: "configuration", label: "Configuration", score: configScore, status: categorizeSeverityForCategory("configuration", configScore) },
    { key: "permissions", label: "Permissions", score: permissionScore, status: categorizeSeverityForCategory("permissions", permissionScore) },
    { key: "assets", label: "Assets", score: assetsScore, status: categorizeSeverityForCategory("assets", assetsScore) },
  ];
}

/**
 * Analyze ZIP bytes fully in the browser.
 *
 * This function is intentionally independent from React so it can be unit
 * tested. It never executes any JavaScript found in the ZIP.
 */
export async function analyzeZipBytes(
  bytes: Uint8Array,
  sourceName: string,
  onProgress?: (step: AnalysisStep) => void,
  onProgressRatio?: (_ratio: number) => void,
): Promise<ExtensionAnalysis> {
  reportStep("reading", onProgress, onProgressRatio);

  let zip: JSZip;
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new ExtensionLabError(
      "zip-corrupt",
      "We couldn't read this ZIP. The file may be corrupted or incorrectly packaged.",
      error instanceof Error ? error.message : "Unknown ZIP parsing error.",
    );
  }

  const rawEntries = Object.values(zip.files);
  if (rawEntries.length === 0) {
    throw new ExtensionLabError(
      "zip-empty",
      "This ZIP is empty.",
      "No entries were found in the package.",
    );
  }
  if (rawEntries.length > MAX_FILE_COUNT) {
    throw new ExtensionLabError(
      "too-many-files",
      `This ZIP contains too many files (more than ${MAX_FILE_COUNT}).`,
      "The package exceeded the configured file count limit.",
    );
  }

  const entries: FileEntry[] = [];
  let totalUncompressedSize = 0;

  for (const entry of rawEntries) {
    const path = normalizePath(entry.name);
    if (!path) continue;
    const segments = path.split("/").filter(Boolean);
    if (isDirectoryName(entry.name)) {
      entries.push({
        path,
        name: segments[segments.length - 1] ?? path,
        type: "folder",
        extension: "",
        size: 0,
        depth: segments.length - 1,
      });
      continue;
    }

    const size = safeUncompressedSize(entry);
    totalUncompressedSize += size;
    if (size > MAX_SINGLE_FILE_SIZE) {
      throw new ExtensionLabError(
        "file-too-large-in-zip",
        "A file inside this ZIP is too large to inspect safely.",
        `"${path}" exceeded the ${MAX_SINGLE_FILE_SIZE} byte single-file limit.`,
      );
    }
    if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE) {
      throw new ExtensionLabError(
        "total-too-large",
        "This ZIP expands to too much data to inspect safely.",
        "The package exceeded the total uncompressed size limit.",
      );
    }

    entries.push({
      path,
      name: segments[segments.length - 1] ?? path,
      type: "file",
      extension: getFileExtension(path),
      size,
      depth: segments.length - 1,
    });
  }

  reportStep("manifest", onProgress, onProgressRatio);

  const fileEntries = entries.filter((entry) => entry.type === "file");
  const manifestEntry = findManifestEntry(fileEntries);
  if (!manifestEntry) {
    throw new ExtensionLabError(
      "manifest-missing",
      "Manifest not found. This ZIP does not appear to contain a browser extension manifest.",
      "No manifest.json was located in the package.",
    );
  }

  const root = getExtensionRoot(entries, manifestEntry);
  const zipObject = zip.file(manifestEntry.path);
  if (!zipObject) {
    throw new ExtensionLabError(
      "manifest-missing",
      "Manifest not found. This ZIP does not appear to contain a browser extension manifest.",
      `Found "${manifestEntry.path}" but it could not be read.`,
    );
  }

  const manifestText = await zipObject.async("string");
  if (manifestText.length > MAX_MANIFEST_SIZE) {
    throw new ExtensionLabError(
      "manifest-too-large",
      "The manifest is too large to inspect.",
      `manifest.json exceeded the ${MAX_MANIFEST_SIZE} byte limit.`,
    );
  }

  let manifestRaw: ReturnType<typeof describeManifest>["raw"];
  try {
    manifestRaw = parseManifestJson(manifestText);
  } catch (error) {
    if (error instanceof ExtensionLabError) throw error;
    throw new ExtensionLabError(
      "manifest-invalid",
      "manifest.json could not be parsed as valid JSON.",
      error instanceof Error ? error.message : "Invalid JSON content.",
    );
  }

  reportStep("structure", onProgress, onProgressRatio);

  const manifest = describeManifest(manifestRaw);
  const permissions = analyzePermissions(manifestRaw);
  const files: FileStructure = {
    entries,
    tree: buildFileTree(entries),
    rootPath: root,
    rootLabel: root ? root.replace(/^.*\//, "") : "ZIP root",
    totalUncompressedSize,
    fileCount: fileEntries.length,
  };

  const issues = buildIssues(entries, manifestRaw, root);
  if (manifest.manifestVersion === "v2") {
    issues.push({
      id: "manifest-v2-compat",
      severity: "info",
      category: "configuration",
      title: "Manifest V2 detected",
      message:
        "Manifest V2 is still supported by some browsers but may be deprecated. Compatibility may matter for your target stores.",
    });
  }
  if (permissions.broadPermissions) {
    issues.push({
      id: "broad-host-access",
      severity: "warning",
      category: "permissions",
      title: "Broad host access",
      message:
        "This extension requests very broad host access. Review recommended before distribution.",
    });
  }

  const categoryScores = buildCategoryScores(issues, manifest.manifestVersion);
  const healthScore = {
    total: Math.round(
      categoryScores.reduce((sum, category) => sum + category.score, 0) / 5,
    ),
    categories: categoryScores,
    basis: "Health score is based on ExtensionLab's Phase 1 checks.",
  };

  reportStep("report", onProgress, onProgressRatio);

  return {
    createdAt: Date.now(),
    sourceName,
    sourceSize: bytes.byteLength,
    rootPath: root,
    metadata: {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      manifestVersionLabel: manifest.manifestVersionLabel,
      fileCount: files.fileCount,
      totalUncompressedSize: files.totalUncompressedSize,
    },
    manifest,
    permissions,
    files,
    issues,
    healthScore,
  };
}

function reportStep(
  id: AnalysisStep["id"],
  onProgress?: (step: AnalysisStep) => void,
  onProgressRatio?: (_ratio: number) => void,
): void {
  const step = ANALYSIS_STEPS.find((candidate) => candidate.id === id);
  if (!step) return;
  onProgress?.(step);
  onProgressRatio?.(step.progress / 100);
}

/**
 * Analyze a user-selected File.
 */
export async function analyzeExtensionFile(
  file: File,
  onProgress?: (step: AnalysisStep) => void,
  onProgressRatio?: (_ratio: number) => void,
): Promise<ExtensionAnalysis> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return analyzeZipBytes(bytes, file.name, onProgress, onProgressRatio);
}


