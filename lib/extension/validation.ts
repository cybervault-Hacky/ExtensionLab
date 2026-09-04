import {
  ACCEPTED_EXTENSIONS,
  MAX_EXTENSION_SIZE,
  REJECTED_EXTENSIONS,
} from "./limits";
import { ExtensionLabError } from "./errors";
import type { ValidationResult } from "@/types/extension";

function getExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  const index = lower.lastIndexOf(".");
  return index === -1 ? "" : lower.slice(index);
}

function extensionIsRejected(extension: string): boolean {
  return REJECTED_EXTENSIONS.includes(
    extension as (typeof REJECTED_EXTENSIONS)[number],
  );
}

/**
 * Validate the selected file before any ZIP reading happens.
 *
 * Returns a ValidationResult. Callers should treat `result.error` carefully and
 * never surface the raw stack trace.
 */
export function validateExtensionFile(file: File): ValidationResult {
  if (!file) {
    return {
      ok: false,
      error: new ExtensionLabError(
        "no-file",
        "No file was selected.",
        "The file input returned no file.",
      ),
    };
  }

  const extension = getExtension(file.name);

  if (!ACCEPTED_EXTENSIONS.includes(extension as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return {
      ok: false,
      error: new ExtensionLabError(
        "unsupported-file",
        "Unsupported file type.",
        extensionIsRejected(extension)
          ? `${file.name} uses a file type that ExtensionLab cannot inspect.`
          : `Please choose a ${ACCEPTED_EXTENSIONS.join(", ")} file.`,
      ),
    };
  }

  if (file.size > MAX_EXTENSION_SIZE) {
    return {
      ok: false,
      error: new ExtensionLabError(
        "file-too-large",
        `This file is larger than the ${Math.round(MAX_EXTENSION_SIZE / 1024 / 1024)} MB limit.`,
        "The selected file exceeded the configured maximum extension size.",
      ),
    };
  }

  return { ok: true };
}
