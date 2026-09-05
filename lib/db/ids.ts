import { randomBytes } from "node:crypto";

/**
 * Non-guessable ids for public database resources. Never use sequential ids in
 * public URLs.
 */
export function generateDbId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}
