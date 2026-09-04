import { randomBytes } from "node:crypto";
import { basename, join, normalize } from "node:path";

/**
 * Server-side error sanitization and safe path helpers.
 *
 * User-facing errors must never leak host paths, container internals,
 * environment variables, or stack traces. Detailed diagnostics are retained
 * only in the server log (and should never contain secrets).
 */

export interface SanitizedError {
  message: string;
  referenceId: string;
}

export function sanitizeError(message: string): SanitizedError {
  const referenceId = `ERR-${randomBytes(6).toString("hex").toUpperCase()}`;
  const sanitized = message
    .replace(/\/private\/[^\s]+/g, "[path]")
    .replace(/\/var\/lib\/docker[^\s]+/g, "[container-path]")
    .replace(/\/tmp\/extensionlab[^\s]+/g, "[temp-path]")
    .replace(/([A-Z_]{2,}=)[^\s]+/g, "$1[redacted]")
    .replace(/\.\/([\w/.-]+):\d+:\d+/g, "runner:$1:[line]")
    .replace(/\bat\s+[\w:./-]+(\s+\(\d+:\d+\))?/g, "")
    .trim();
  return {
    message: sanitized || "The sandbox encountered an unexpected error.",
    referenceId,
  };
}

export function safeTempFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return base || "package.zip";
}

export function safeSandboxPath(sandboxId: string, root: string, relative: string): string {
  const normalized = normalize(relative);
  if (normalized.split(/[/\\]/).includes("..")) {
    throw new Error("Unsafe path provided.");
  }
  const sandboxDir = join(root, sandboxId);
  return join(sandboxDir, normalized);
}

/** Strip control characters from untrusted log values before display. */
export function cleanRuntimeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}
