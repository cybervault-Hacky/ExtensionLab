/**
 * Application-level error used for user-facing extension analysis failures.
 *
 * Raw exceptions from JSZip / browser APIs are never surfaced directly to the
 * UI. We wrap them in ExtensionLabError with a developer-friendly message.
 */

export type ExtensionErrorCode =
  | "no-file"
  | "unsupported-file"
  | "file-too-large"
  | "zip-corrupt"
  | "zip-empty"
  | "manifest-missing"
  | "manifest-invalid"
  | "manifest-too-large"
  | "too-many-files"
  | "total-too-large"
  | "file-too-large-in-zip"
  | "unknown";

export class ExtensionLabError extends Error {
  code: ExtensionErrorCode;
  detail?: string;

  constructor(code: ExtensionErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "ExtensionLabError";
    this.code = code;
    this.detail = detail;
  }
}
