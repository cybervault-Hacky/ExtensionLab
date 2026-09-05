import { createHash, randomBytes } from "node:crypto";
import { generateSessionToken } from "@/lib/runtime/ids";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateAuthToken(): string {
  return generateSessionToken();
}

export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}
