/**
 * Configurable limits for Phase 1 local ZIP analysis.
 *
 * These are deliberately kept as constants so they can be tuned centrally in a
 * later phase without touching the analyzer or the UI.
 */

/** Maximum accepted extension package size (25 MB). */
export const MAX_EXTENSION_SIZE = 25 * 1024 * 1024;

/** Maximum number of entries read from an uploaded ZIP. */
export const MAX_FILE_COUNT = 800;

/** Maximum total uncompressed bytes read from a ZIP (zip-bomb guard). */
export const MAX_TOTAL_UNCOMPRESSED_SIZE = 120 * 1024 * 1024;

/** Maximum uncompressed size of any single file. */
export const MAX_SINGLE_FILE_SIZE = 25 * 1024 * 1024;

/** Maximum size of a single manifest.json that we parse. */
export const MAX_MANIFEST_SIZE = 512 * 1024;

export const ACCEPTED_EXTENSIONS = [".zip"] as const;

export const REJECTED_EXTENSIONS = [
  ".exe",
  ".apk",
  ".rar",
  ".7z",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".txt",
  ".md",
  ".pdf",
] as const;

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, index);
  const rounded = value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[index]}`;
}
