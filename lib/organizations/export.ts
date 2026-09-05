import "server-only";
import { createHash } from "node:crypto";
import { getConfig } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { getStorage } from "@/lib/storage/storage";
import { recordAuditEvent } from "@/lib/audit/service";
import { dispatchOrganizationEvent } from "@/lib/webhooks/dispatch";
import { canUseOrgFeature } from "./entitlements";
import { getExportRow, getMembership, insertExportRow, listExportRows, updateExportRow } from "./repository";

/**
 * Asynchronous organization data export (Phase 10).
 *
 * Exports gather *metadata* only — organization profile, members, resource
 * summaries, reports metadata and audit events. Raw secrets never exist in
 * exports because they are never stored in the first place; uploaded source
 * packages are deliberately not re-packaged (they remain available through the
 * artifact system under their own retention).
 *
 * The export job runs through the normal worker queue, writes a single JSON
 * artifact into storage with an expiry, and is audited at every transition.
 */

const PAGE = 200;

export interface ExportView {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "expired";
  size: number | null;
  expiresAt: number;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
}

function toView(row: { id: string; status: string; size: number | null; expires_at: number; created_at: number; finished_at: number | null; error: string | null }): ExportView {
  return {
    id: row.id,
    status: row.status as ExportView["status"],
    size: row.size,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

/** Rate-limited by the API route; the service enforces entitlement + role. */
export async function requestExport(ctx: { userId: string; organizationId: string; requestId?: string | null; ip?: string | null }): Promise<ExportView> {
  const entitlement = canUseOrgFeature(ctx.organizationId, "dataExport");
  if (!entitlement.allowed) throw new AppError("PAYMENT_REQUIRED", { message: entitlement.message });
  const actor = getMembership(ctx.organizationId, ctx.userId);
  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) throw new AppError("ROLE_REQUIRED");
  // At most one queued/running export per organization.
  const running = listExportRows(ctx.organizationId, 10).find((row) => row.status === "queued" || row.status === "running");
  if (running) throw new AppError("CONFLICT", { message: "An export is already being prepared." });
  const row = insertExportRow({
    organizationId: ctx.organizationId,
    requestedBy: ctx.userId,
    expiresAt: Date.now() + getConfig().organizations.exportExpiryMs,
  });
  const { enqueueJob } = await import("@/lib/jobs/queue");
  const { notifyEmbeddedWorker } = await import("@/lib/jobs/runtime");
  enqueueJob({
    type: "ORG_EXPORT",
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    payload: { exportId: row.id, organizationId: ctx.organizationId },
    idempotencyKey: `org-export:${row.id}`,
    resourceType: "export",
    resourceId: row.id,
    skipBackpressure: true,
  });
  notifyEmbeddedWorker();
  recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "export.requested", resourceType: "export", resourceId: row.id, requestId: ctx.requestId, ip: ctx.ip });
  return toView(row);
}

/** Paginated metadata gathering — never loads an unbounded history. */
function gatherExportData(organizationId: string): Record<string, unknown> {
  const db = getDb();
  const page = <T>(sql: string, ...params: Array<string | number>): T[] => db.prepare(`${sql} LIMIT ?`).all(...params, PAGE) as unknown as T[];
  const org = db.prepare("SELECT id, name, slug, plan_id, plan_status, seats, created_at FROM organizations WHERE id = ?").get(organizationId);
  const members = page(
    "SELECT u.email, u.name, m.role, m.created_at AS joined_at FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.created_at",
    organizationId,
  );
  const projects = page("SELECT id, name, version, health_score, created_at FROM extensions WHERE organization_id = ? ORDER BY created_at", organizationId);
  const packages = page("SELECT id, sha256, size, version, original_name, created_at FROM extension_packages WHERE organization_id = ? ORDER BY created_at", organizationId);
  const runs = page("SELECT id, status, outcome, score, browser_id, created_at FROM test_runs WHERE organization_id = ? ORDER BY created_at DESC", organizationId);
  const matrices = page("SELECT id, status, compatibility_score, coverage, created_at FROM browser_matrix_runs WHERE organization_id = ? ORDER BY created_at DESC", organizationId);
  const reports = page("SELECT id, title, runtime_score, overall_score, created_at FROM reports WHERE organization_id = ? ORDER BY created_at DESC", organizationId);
  const audit = page("SELECT action, resource_type, resource_id, success, created_at FROM organization_audit_events WHERE organization_id = ? ORDER BY created_at DESC", organizationId);
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    organization: org,
    counts: {
      members: members.length,
      projects: projects.length,
      packages: packages.length,
      testRuns: runs.length,
      browserMatrices: matrices.length,
      reports: reports.length,
      auditEvents: audit.length,
    },
    members,
    projects,
    packages,
    testRuns: runs,
    browserMatrices: matrices,
    reports,
    auditEvents: audit,
    note: "Metadata export. Uploaded package bytes are not included; download them through the artifact system before retention expires.",
  };
}

/** Runs inside the worker (ORG_EXPORT job). Bounded, idempotent, audited. */
export async function runOrganizationExport(exportId: string, organizationId: string): Promise<{ status: string; size: number }> {
  const row = getExportRow(organizationId, exportId);
  if (!row) throw new Error("Export not found.");
  if (row.status === "completed" || row.status === "running") return { status: row.status, size: row.size ?? 0 };
  updateExportRow(exportId, { status: "running" });
  try {
    const data = gatherExportData(organizationId);
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
    const storageKey = `exports/${organizationId}/${exportId}.json`;
    await getStorage().put(storageKey, bytes, { contentType: "application/json" });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    updateExportRow(exportId, { status: "completed", storage_key: storageKey, size: bytes.byteLength, sha256, finished_at: Date.now() });
    recordAuditEvent({ organizationId, actorUserId: row.requested_by, action: "export.completed", resourceType: "export", resourceId: exportId, metadata: { size: String(bytes.byteLength) } });
    dispatchOrganizationEvent(organizationId, "export.completed", { exportId, organizationId });
    recordMetric("export.completed", 1);
    return { status: "completed", size: bytes.byteLength };
  } catch (error) {
    const message = error instanceof AppError ? error.userMessage : "The export could not be generated.";
    updateExportRow(exportId, { status: "failed", error: message, finished_at: Date.now() });
    recordAuditEvent({ organizationId, actorUserId: row.requested_by, action: "export.failed", resourceType: "export", resourceId: exportId, success: false });
    dispatchOrganizationEvent(organizationId, "export.failed", { exportId, organizationId });
    logger.error("export.failed", { exportId, organizationId, errorCode: (error as { code?: string }).code ?? "INTERNAL" });
    return { status: "failed", size: 0 };
  }
}

export function listExports(ctx: { userId: string; organizationId: string }): ExportView[] {
  const actor = getMembership(ctx.organizationId, ctx.userId);
  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) throw new AppError("ROLE_REQUIRED");
  return listExportRows(ctx.organizationId, 50).map(toView);
}

/** Authorized download: membership + admin role + completed + unexpired. */
export function getExportDownload(ctx: { userId: string; organizationId: string }, exportId: string): { storageKey: string; size: number; expiresAt: number } {
  const actor = getMembership(ctx.organizationId, ctx.userId);
  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) throw new AppError("ROLE_REQUIRED");
  const row = getExportRow(ctx.organizationId, exportId);
  if (!row) throw new AppError("NOT_FOUND", { message: "Export not found." });
  if (row.status !== "completed" || !row.storage_key) throw new AppError("EXPORT_NOT_READY");
  if (Date.now() > row.expires_at) throw new AppError("EXPORT_NOT_READY", { message: "This export has expired." });
  recordAuditEvent({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "export.downloaded", resourceType: "export", resourceId: exportId });
  return { storageKey: row.storage_key, size: row.size ?? 0, expiresAt: row.expires_at };
}

/** Retention sweep: delete expired export blobs + mark rows expired. */
export async function expireExports(now = Date.now()): Promise<number> {
  const { listExpiredExports } = await import("./repository");
  const expired = listExpiredExports(now);
  let removed = 0;
  for (const row of expired) {
    if (row.storage_key) {
      await getStorage().delete(row.storage_key).catch(() => undefined);
      removed += 1;
    }
    updateExportRow(row.id, { status: "expired" });
  }
  return removed;
}
