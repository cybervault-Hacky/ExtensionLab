import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { ExtensionPackageRow } from "../schema/types";

export type PackageStatus = "stored" | "deleting" | "deleted";

export interface ExtensionPackage {
  id: string;
  extensionId: string | null;
  sha256: string;
  size: number;
  version: string | null;
  originalName: string | null;
  createdAt: number;
}

export function toPackage(row: ExtensionPackageRow): ExtensionPackage {
  return {
    id: row.id,
    extensionId: row.extension_id,
    sha256: row.sha256,
    size: row.size,
    version: row.version,
    originalName: row.original_name,
    createdAt: row.created_at,
  };
}

export function createPackageRecord(input: {
  userId: string;
  extensionId: string | null;
  storageKey: string;
  sha256: string;
  size: number;
  version: string | null;
  originalName: string | null;
  id?: string;
  organizationId?: string | null;
}): ExtensionPackageRow {
  const db = getDb();
  const now = Date.now();
  const id = input.id ?? generateDbId("pkg");
  db.prepare(
    `INSERT INTO extension_packages
      (id, user_id, extension_id, storage_key, sha256, size, version, original_name, status, created_at, updated_at, last_used_at, organization_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.extensionId,
    input.storageKey,
    input.sha256,
    input.size,
    input.version,
    input.originalName,
    now,
    now,
    null,
    input.organizationId ?? null,
  );
  return getPackageById(id)!;
}

export function getPackageById(id: string): ExtensionPackageRow | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM extension_packages WHERE id = ?").get(id) as ExtensionPackageRow | undefined) ??
    null
  );
}

/** Phase 10: organization-scoped package lookup (API-key paths). */
export function getOrgPackage(organizationId: string, id: string): ExtensionPackageRow | null {
  const row = getDb()
    .prepare("SELECT * FROM extension_packages WHERE id = ? AND organization_id = ? AND status = 'stored'")
    .get(id, organizationId);
  return (row as ExtensionPackageRow | undefined) ?? null;
}

export function getOwnedPackage(userId: string, id: string): ExtensionPackageRow | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM extension_packages WHERE id = ? AND user_id = ? AND status = 'stored'")
      .get(id, userId) as ExtensionPackageRow | undefined) ?? null
  );
}

export function findStoredPackageByHash(userId: string, sha256: string): ExtensionPackageRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        "SELECT * FROM extension_packages WHERE user_id = ? AND sha256 = ? AND status = 'stored' ORDER BY created_at DESC LIMIT 1",
      )
      .get(userId, sha256) as ExtensionPackageRow | undefined) ?? null
  );
}

export function touchPackage(id: string): void {
  getDb()
    .prepare("UPDATE extension_packages SET last_used_at = ?, updated_at = ? WHERE id = ?")
    .run(Date.now(), Date.now(), id);
}

export function attachPackageToExtension(id: string, extensionId: string): void {
  getDb()
    .prepare("UPDATE extension_packages SET extension_id = ?, updated_at = ? WHERE id = ? AND extension_id IS NULL")
    .run(extensionId, Date.now(), id);
}

export function setPackageStatus(id: string, status: PackageStatus): void {
  getDb()
    .prepare("UPDATE extension_packages SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, Date.now(), id);
}

export function deletePackageRecord(id: string): void {
  getDb().prepare("DELETE FROM extension_packages WHERE id = ?").run(id);
}

export function listPackagesForUser(userId: string, limit = 50): ExtensionPackageRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM extension_packages WHERE user_id = ? AND status = 'stored' ORDER BY created_at DESC LIMIT ?",
    )
    .all(userId, limit) as unknown as ExtensionPackageRow[];
}

export function listPackagesForExtension(extensionId: string): ExtensionPackageRow[] {
  return getDb()
    .prepare("SELECT * FROM extension_packages WHERE extension_id = ? ORDER BY created_at DESC")
    .all(extensionId) as unknown as ExtensionPackageRow[];
}

/** All storage keys currently referenced by package rows (for reconciliation). */
export function listAllPackageKeys(): Array<{ id: string; storage_key: string; status: string }> {
  return getDb()
    .prepare("SELECT id, storage_key, status FROM extension_packages")
    .all() as unknown as Array<{ id: string; storage_key: string; status: string }>;
}

/**
 * Packages that no longer have any reference (no snapshot, no test run, no
 * extension) and are older than the retention window.
 */
export function listOrphanedPackages(olderThan: number, limit = 100): ExtensionPackageRow[] {
  return getDb()
    .prepare(
      `SELECT p.* FROM extension_packages p
       WHERE p.created_at < ?
         AND p.status = 'stored'
         AND NOT EXISTS (SELECT 1 FROM test_runs r WHERE r.package_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM analysis_snapshots s WHERE s.package_id = p.id)
         AND (p.extension_id IS NULL OR NOT EXISTS (SELECT 1 FROM extensions e WHERE e.id = p.extension_id))
       ORDER BY p.created_at ASC
       LIMIT ?`,
    )
    .all(olderThan, limit) as unknown as ExtensionPackageRow[];
}

/** Packages whose retention window elapsed and that no active run references. */
export function listExpiredPackages(olderThan: number, limit = 100): ExtensionPackageRow[] {
  return getDb()
    .prepare(
      `SELECT p.* FROM extension_packages p
       WHERE COALESCE(p.last_used_at, p.created_at) < ?
         AND p.status = 'stored'
         AND NOT EXISTS (
           SELECT 1 FROM test_runs r
           WHERE r.package_id = p.id
             AND r.status IN ('idle','queued','preparing','starting','running','stopping')
         )
       ORDER BY p.created_at ASC
       LIMIT ?`,
    )
    .all(olderThan, limit) as unknown as ExtensionPackageRow[];
}

export function listPackagesMarkedDeleting(limit = 100): ExtensionPackageRow[] {
  return getDb()
    .prepare("SELECT * FROM extension_packages WHERE status = 'deleting' ORDER BY updated_at ASC LIMIT ?")
    .all(limit) as unknown as ExtensionPackageRow[];
}
