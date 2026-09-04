import "server-only";

export type SandboxErrorCode =
  | "environment_unavailable"
  | "capacity_reached"
  | "rate_limited"
  | "not_found"
  | "unauthorized"
  | "invalid_action"
  | "invalid_url"
  | "invalid_extension"
  | "runner_unavailable"
  | "extension_load_failed"
  | "timeout"
  | "cleanup_failed";

export class SandboxRuntimeError extends Error {
  code: SandboxErrorCode;
  referenceId: string;

  constructor(code: SandboxErrorCode, message: string, referenceId: string) {
    super(message);
    this.name = "SandboxRuntimeError";
    this.code = code;
    this.referenceId = referenceId;
  }
}
