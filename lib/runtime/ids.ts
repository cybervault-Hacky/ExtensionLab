import { randomBytes } from "node:crypto";

/** Non-guessable public sandbox id. Internal container ids are never exposed. */
export function generateSandboxId(): string {
  return `sandbox_${randomBytes(8).toString("hex")}`;
}

/** Per-session authorization token. */
export function generateSessionToken(): string {
  return `${randomBytes(24).toString("base64url")}`;
}

/** Short reference id shown to users on errors. */
export function generateReferenceId(): string {
  return randomBytes(6).toString("hex").toUpperCase();
}

/** Internal event id. */
export function generateEventId(): string {
  return `${randomBytes(8).toString("hex")}`;
}
