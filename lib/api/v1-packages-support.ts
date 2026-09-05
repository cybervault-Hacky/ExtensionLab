import "server-only";
import { getDb } from "@/lib/db/client";
import { getStorage } from "@/lib/storage/storage";
import { createHash } from "node:crypto";
import { AppError } from "@/lib/observability/errors";
import type { ExtensionPackageRow } from "@/lib/db/schema/types";

/**
 * Integrity-verified package bytes for organization-scoped API paths. The
 * SHA-256 is re-verified after reading so a corrupted/tampered blob can never
 * reach the analyzer or a sandbox.
 */
export async function readVerifiedPackageBytesForOrg(organizationId: string, packageId: string): Promise<Uint8Array> {
  const row = getDb()
    .prepare("SELECT * FROM extension_packages WHERE id = ? AND organization_id = ? AND status = 'stored'")
    .get(packageId, organizationId) as unknown as ExtensionPackageRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", { message: "Package not found." });
  const stored = await getStorage().get(row.storage_key);
  if (stored.byteLength !== row.size || createHash("sha256").update(stored).digest("hex") !== row.sha256) {
    throw new AppError("STORAGE_ERROR", { message: "The stored package failed its integrity check." });
  }
  return stored;
}
