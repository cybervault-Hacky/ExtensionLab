import "server-only";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config/env";
import { getDb, transaction } from "@/lib/db/client";
import { validateTestUrlWithDns } from "@/lib/runtime/urls";
import type { SandboxDriver, ContainerHandle } from "@/lib/runtime/driver";
import { ControlClient } from "@/lib/runtime/control-client";
import { createDockerDriver } from "@/lib/runtime/docker-driver";
import { getExtensionById, getOwnedExtension } from "@/lib/db/repositories/extensions";
import { getOwnedPackage } from "@/lib/db/repositories/packages";
import { getSnapshotByPackageId } from "@/lib/db/repositories/snapshots";
import {
  appendSessionEvent,
  createSessionArtifactRecord,
  getSessionById,
  getOwnedSession,
  insertSession,
  listSessionArtifacts,
  listSessionEvents,
  transitionSession,
  touchSessionActivity,
  COMMANDABLE_SESSION_STATUSES,
  type InteractiveSessionStatus,
} from "@/lib/db/repositories/browser-sessions";
import { cancelJob } from "@/lib/jobs/queue";
import { consumeReservationForResource, releaseReservationForResource, reserveQuota } from "@/lib/db/repositories/quota";
import { recordUsage } from "@/lib/db/repositories/usage";
import {
  canUseInteractiveBrowser,
  getInteractiveBrowserConcurrency,
  getInteractiveBrowserMaxMinutes,
  getRetentionForUser,
} from "@/lib/billing/entitlements";
import { getStorage } from "@/lib/storage/storage";
import { artifactStorageKey, sha256Hex } from "@/lib/storage/validation";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { getInteractiveHub, type HubAttachInfo } from "./runtime";
import { validateInputAction, validateViewport } from "./limits";
import type {
  ConsoleEntryView,
  InteractiveBrowserSessionView,
  InteractiveExtensionInfo,
  InteractiveSessionEventView,
  NetworkEntryView,
  NavigationOperation,
  ScreenshotArtifactView,
} from "@/types/interactive";
import type { InteractiveBrowserSessionRow } from "@/lib/db/schema/types";
import type { UserRecord } from "@/lib/db/repositories/users";

/**
 * Interactive browser session service (Phase 11).
 *
 * One immutable package binding per session, one disposable container per
 * session, one typed allowlisted command vocabulary. The service is the only
 * place that mutates session state; the API routes and job handlers call it.
 */

/** Host-internal runtime coordinates. Persisted in runtime_json, never exposed. */
export interface SessionRuntimeInfo {
  sandboxId: string;
  containerName: string;
  containerId: string;
  controlPort: number;
  runnerToken: string;
  tempDir: string;
}

export function parseRuntimeInfo(row: InteractiveBrowserSessionRow): SessionRuntimeInfo | null {
  try {
    const parsed = JSON.parse(row.runtime_json) as Partial<SessionRuntimeInfo>;
    if (
      typeof parsed.controlPort === "number" &&
      typeof parsed.runnerToken === "string" &&
      parsed.runnerToken.length > 0
    ) {
      return {
        sandboxId: parsed.sandboxId ?? "",
        containerName: parsed.containerName ?? "",
        containerId: parsed.containerId ?? "",
        controlPort: parsed.controlPort,
        runnerToken: parsed.runnerToken,
        tempDir: parsed.tempDir ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeRuntimeInfo(info: SessionRuntimeInfo): string {
  return JSON.stringify(info);
}

export function hubInfo(row: InteractiveBrowserSessionRow): HubAttachInfo | null {
  const runtime = parseRuntimeInfo(row);
  if (!runtime) return null;
  return { sessionId: row.id, controlPort: runtime.controlPort, runnerToken: runtime.runnerToken };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function parseExtensionInfo(row: InteractiveBrowserSessionRow): InteractiveExtensionInfo {
  return parseExtensionInfoJson(row.extension_info_json);
}

/** Parses persisted extension info JSON, degrading to empty info on any error. */
export function parseExtensionInfoJson(json: string | null): InteractiveExtensionInfo {
  const empty = emptyExtensionInfo();
  try {
    const parsed = JSON.parse(json ?? "null") as Partial<InteractiveExtensionInfo>;
    return {
      name: parsed.name ?? null,
      version: parsed.version ?? null,
      manifestVersion: parsed.manifestVersion ?? null,
      popupPath: parsed.popupPath ?? null,
      hasServiceWorker: parsed.hasServiceWorker === true,
      hasContentScripts: parsed.hasContentScripts === true,
      contentScriptMatches: Array.isArray(parsed.contentScriptMatches) ? parsed.contentScriptMatches.slice(0, 50) : [],
      permissions: Array.isArray(parsed.permissions) ? parsed.permissions.slice(0, 60) : [],
      hostPermissions: Array.isArray(parsed.hostPermissions) ? parsed.hostPermissions.slice(0, 60) : [],
    };
  } catch {
    return {
      ...empty,
    };
  }
}

export function toSessionView(row: InteractiveBrowserSessionRow): InteractiveBrowserSessionView {
  const config = getConfig().interactiveBrowser;
  const extensionName = row.extension_id ? getExtensionById(row.extension_id)?.name ?? null : null;
  return {
    id: row.id,
    projectId: row.extension_id,
    packageName: extensionName,
    packageId: row.package_id,
    packageVersion: row.package_version,
    packageSha256: row.package_sha256,
    browser: row.browser,
    browserVersion: row.browser_version,
    status: row.status as InteractiveBrowserSessionView["status"],
    stateReason: row.state_reason,
    stopReason: row.stop_reason,
    currentUrl: row.current_url,
    initialUrl: row.initial_url,
    viewport: { width: row.viewport_width, height: row.viewport_height },
    popupOpen: row.popup_open === 1,
    popupSize: row.popup_width && row.popup_height ? { width: row.popup_width, height: row.popup_height } : null,
    artifactCount: row.artifact_count,
    extension: parseExtensionInfo(row),
    createdAt: row.created_at,
    startedAt: row.started_at,
    readyAt: row.ready_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    stoppedAt: row.stopped_at,
    limits: {
      maxSessionMinutes: getInteractiveBrowserMaxMinutes(row.user_id),
      idleTimeoutMs: config.idleTimeoutMs,
      frameIntervalMs: config.frameIntervalMs,
    },
  };
}

export function toEventView(row: {
  seq: number;
  type: string;
  level: string;
  message: string;
  metadata_json: string;
  created_at: number;
}): InteractiveSessionEventView {
  let metadata: Record<string, string | number | boolean | null> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as Record<string, string | number | boolean | null>;
  } catch {
    metadata = {};
  }
  return {
    seq: row.seq,
    type: row.type,
    level: row.level === "warning" || row.level === "error" ? row.level : "info",
    message: row.message,
    metadata,
    timestamp: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  userId: string;
  packageId: string;
  initialUrl?: string | null;
  viewportWidth?: number;
  viewportHeight?: number;
  requestId?: string | null;
}

/**
 * Creates a session bound to one exact immutable package. The package bytes
 * are resolved from authenticated ownership — never from a client path — and
 * the binding records version + SHA-256 so nothing can silently switch.
 */
export function createInteractiveSession(user: UserRecord, input: CreateSessionInput): InteractiveBrowserSessionRow {
  const config = getConfig().interactiveBrowser;
  if (!config.enabled) {
    throw new AppError("BROWSER_UNAVAILABLE", { message: "Interactive browser testing is disabled on this deployment." });
  }

  const pkg = getOwnedPackage(user.id, input.packageId);
  if (!pkg) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Package not found." });

  const urlResult = input.initialUrl ? safeUrl(input.initialUrl) : { ok: true as const };
  if (!urlResult.ok) {
    throw new AppError("UNSAFE_URL", { message: urlResult.reason });
  }
  const initialUrl = "url" in urlResult && urlResult.url ? urlResult.url : null;

  const viewportResult = validateViewport(
    input.viewportWidth ?? 1280,
    input.viewportHeight ?? 800,
  );
  if (!viewportResult.ok) {
    throw new AppError("INVALID_INPUT", { message: viewportResult.reason });
  }

  // Entitlement + per-period quota, decided server-side only.
  const entitlement = canUseInteractiveBrowser(user.id);
  if (!entitlement.allowed) {
    if (entitlement.reason === "quota") {
      throw new AppError("QUOTA_EXCEEDED", {
        message: "Your plan's interactive browser session limit has been reached.",
      });
    }
    const message =
      entitlement.reason === "plan" && "message" in entitlement
        ? (entitlement as { message?: string }).message
        : undefined;
    throw new AppError("PAYMENT_REQUIRED", { message: message ?? "Interactive browser testing requires a paid plan." });
  }

  // Snapshot safe extension metadata for the details panel from the analysis
  // recorded for this exact package (no re-parsing of untrusted input here).
  const extensionInfo = extensionInfoForPackage(pkg.extension_id, input.packageId, pkg.version ?? null);

  const maxMinutes = getInteractiveBrowserMaxMinutes(user.id);
  const sessionId = `ibs_${randomBytes(12).toString("hex")}`;

  const row = transaction(getDb(), () => {
    const reservation = reserveQuota({
      userId: user.id,
      kind: "interactive_browser",
      resourceId: sessionId,
      jobId: null,
    });
    const created = insertSession(sessionId, {
      userId: user.id,
      organizationId: pkg.organization_id ?? null,
      extensionId: pkg.extension_id ?? null,
      packageId: pkg.id,
      packageVersion: pkg.version ?? null,
      packageSha256: pkg.sha256,
      browser: "chromium",
      viewportWidth: viewportResult.width,
      viewportHeight: viewportResult.height,
      initialUrl,
      extensionInfoJson: JSON.stringify(extensionInfo),
      quotaReservationId: reservation.id,
      requestId: input.requestId ?? null,
      expiresAt: Date.now() + maxMinutes * 60 * 1000,
    });
    appendSessionEvent(sessionId, {
      type: "session_created",
      message: "Interactive browser session created.",
      metadata: {
        packageId: pkg.id,
        packageSha256: pkg.sha256,
        browser: "chromium",
        viewport: `${viewportResult.width}x${viewportResult.height}`,
      },
    });
    return created;
  });

  logger.info("interactive.session_created", {
    component: "interactive",
    sessionId: row.id,
    userId: user.id,
    organizationId: row.organization_id ?? undefined,
    packageId: pkg.id,
  });
  recordMetric("interactive.session_created", 1);
  return row;
}

export function emptyExtensionInfo(fallbackVersion: string | null = null): InteractiveExtensionInfo {
  return {
    name: null,
    version: fallbackVersion,
    manifestVersion: null,
    popupPath: null,
    hasServiceWorker: false,
    hasContentScripts: false,
    contentScriptMatches: [],
    permissions: [],
    hostPermissions: [],
  };
}

/**
 * Fills extension panel info from a parsed manifest.json. Pure and defensive:
 * the manifest is untrusted input, so every field is type-checked before use.
 */
export function extensionInfoFromManifest(raw: unknown, base: InteractiveExtensionInfo): InteractiveExtensionInfo {
  const info: InteractiveExtensionInfo = { ...base, contentScriptMatches: [], permissions: [], hostPermissions: [] };
  if (!raw || typeof raw !== "object") return info;
  const manifest = raw as Record<string, unknown>;
  if (typeof manifest.name === "string" && manifest.name.trim()) info.name = manifest.name.trim().slice(0, 120);
  if (typeof manifest.version === "string" && manifest.version.trim()) info.version = manifest.version.trim().slice(0, 40);
  if (typeof manifest.manifest_version === "number") info.manifestVersion = `MV${manifest.manifest_version}`;

  const action = (manifest.action ?? manifest.browser_action ?? manifest.page_action) as
    | { default_popup?: unknown }
    | undefined;
  if (action && typeof action.default_popup === "string" && action.default_popup.trim()) {
    info.popupPath = action.default_popup.replace(/^\/+/, "").slice(0, 200);
  }
  const background = manifest.background as { service_worker?: unknown } | undefined;
  info.hasServiceWorker = typeof background?.service_worker === "string";
  const contentScripts = manifest.content_scripts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contentScripts) && contentScripts.length > 0) {
    info.hasContentScripts = true;
    const matches = new Set<string>();
    for (const script of contentScripts.slice(0, 20)) {
      if (!script || typeof script !== "object") continue;
      const scriptMatches = script.matches;
      if (!Array.isArray(scriptMatches)) continue;
      for (const match of scriptMatches) {
        if (typeof match === "string" && match.trim()) matches.add(match.trim().slice(0, 200));
      }
    }
    info.contentScriptMatches = [...matches].slice(0, 50);
  }
  const permissions = manifest.permissions;
  if (Array.isArray(permissions)) {
    info.permissions = permissions.filter((perm): perm is string => typeof perm === "string").slice(0, 60);
  }
  const hostPermissions = manifest.host_permissions;
  if (Array.isArray(hostPermissions)) {
    info.hostPermissions = hostPermissions.filter((perm): perm is string => typeof perm === "string").slice(0, 60);
  }
  return info;
}

function extensionInfoForPackage(
  extensionId: string | null,
  packageId: string,
  fallbackVersion: string | null,
): InteractiveExtensionInfo {
  const info = emptyExtensionInfo(fallbackVersion);
  if (extensionId) {
    const extension = getExtensionById(extensionId);
    if (extension) info.name = extension.name;
  }
  const snapshot = getSnapshotByPackageId(packageId);
  if (snapshot) {
    try {
      const analysis = JSON.parse(snapshot.analysis_json) as {
        metadata?: { name?: string; version?: string };
        manifest?: { raw?: Record<string, unknown> };
      };
      info.name = analysis.metadata?.name ?? info.name;
      info.version = analysis.metadata?.version ?? info.version;
      return extensionInfoFromManifest(analysis.manifest?.raw ?? null, info);
    } catch {
      // Snapshot metadata is optional; the panel degrades gracefully.
    }
  }
  return info;
}

/**
 * Persists extension panel info derived from the extracted manifest. Called by
 * the start handler once the package bytes have been verified and extracted, so
 * popup/service-worker/content-script facts always come from the exact package
 * that was loaded (snapshots may not exist for fresh uploads).
 */
export function setSessionExtensionInfo(sessionId: string, info: InteractiveExtensionInfo): void {
  const db = getDb();
  db.prepare("UPDATE interactive_browser_sessions SET extension_info_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(info),
    Date.now(),
    sessionId,
  );
}

// ---------------------------------------------------------------------------
// Start / stop lifecycle
// ---------------------------------------------------------------------------

/**
 * Enqueues the start job and marks the session QUEUED. The worker performs the
 * heavy start (package verification, container, browser, extension evidence).
 */
export function startInteractiveSession(userId: string, sessionId: string, enqueue: (row: InteractiveBrowserSessionRow) => { jobId: string }): InteractiveBrowserSessionRow {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  if (row.status === "QUEUED" || row.status === "STARTING") return row;
  if (["READY", "ACTIVE", "IDLE"].includes(row.status)) return row;
  if (["STOPPED", "EXPIRED", "FAILED"].includes(row.status)) {
    throw new AppError("SESSION_NOT_READY", { message: "This session has already ended. Create a new session." });
  }

  const updated = transitionSession(row.id, ["CREATED"], "QUEUED", {
    stateReason: "Waiting for a browser slot.",
    jobId: null,
  });
  if (!updated) throw new AppError("CONFLICT", { message: "The session could not be queued." });
  const { jobId } = enqueue(updated);
  const withJob = transitionSession(updated.id, ["QUEUED"], "QUEUED", { jobId });
  appendSessionEvent(row.id, { type: "session_queued", message: "Session queued; waiting for a browser slot." });
  recordMetric("interactive.session_queued", 1);
  return withJob ?? updated;
}

export interface DestroyOptions {
  from: readonly InteractiveSessionStatus[];
  to: "STOPPED" | "EXPIRED" | "FAILED";
  stopReason: string;
  stateReason: string;
  releaseQuota?: boolean;
  events?: { type: string; message: string; level?: "info" | "warning" | "error" }[];
}

/**
 * Terminates a session: conditional state transition, container removal, temp
 * directory cleanup, quota release, event trail, metrics. Idempotent — every
 * termination path funnels through here.
 */
export async function destroyInteractiveSession(
  row: InteractiveBrowserSessionRow,
  driver: SandboxDriver,
  options: DestroyOptions,
): Promise<InteractiveBrowserSessionRow | null> {
  const updated = transitionSession(row.id, options.from, options.to, {
    stateReason: options.stateReason,
    stopReason: options.stopReason,
    stoppedAt: Date.now(),
  });
  if (!updated) return null;
  if (options.events) {
    for (const event of options.events) {
      appendSessionEvent(row.id, { type: event.type, message: event.message, level: event.level });
    }
  }

  const runtime = parseRuntimeInfo(row);
  let cleanupFailures = 0;
  if (runtime) {
    if (runtime.containerId || runtime.containerName) {
      const handle: ContainerHandle = {
        containerId: runtime.containerId,
        controlPort: runtime.controlPort,
        controlClient: new ControlClient(runtime.controlPort),
        runnerToken: runtime.runnerToken,
        browserId: row.browser,
      };
      try {
        await driver.remove(handle);
      } catch {
        cleanupFailures++;
      }
    }
    if (runtime.tempDir) {
      await rm(runtime.tempDir, { recursive: true, force: true }).catch(() => {
        cleanupFailures++;
      });
    }
  }
  if (options.releaseQuota !== false && row.quota_reservation_id) {
    releaseReservationForResource(row.id);
  }
  getInteractiveHub().remove(row.id);
  recordMetric("interactive.session_terminated", 1, { status: options.to, reason: options.stopReason });
  if (cleanupFailures > 0) recordMetric("interactive.cleanup_failures", cleanupFailures);
  logger.info("interactive.session_terminated", {
    component: "interactive",
    sessionId: row.id,
    userId: row.user_id,
    result: options.to,
    reason: options.stopReason,
  });
  return getSessionById(row.id);
}

/** User-initiated stop (synchronous: the container is destroyed immediately). */
export async function stopInteractiveSession(
  userId: string,
  sessionId: string,
  driver: SandboxDriver,
): Promise<InteractiveBrowserSessionRow> {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  if (["STOPPED", "EXPIRED", "FAILED"].includes(row.status)) return row;

  appendSessionEvent(row.id, { type: "session_stopping", message: "Stopping the browser session." });
  if (row.job_id) cancelJob(row.job_id);

  const stopped = await destroyInteractiveSession(row, driver, {
    from: ["CREATED", "QUEUED", "STARTING", "READY", "ACTIVE", "IDLE", "STOPPING"],
    to: "STOPPED",
    stopReason: "stopped_by_user",
    stateReason: "Session stopped by the user.",
    events: [{ type: "session_stopped", message: "Session stopped and resources cleaned up." }],
  });
  return stopped ?? getSessionById(sessionId)!;
}

// ---------------------------------------------------------------------------
// Command operations (navigation / input / popup / viewport / reload)
// ---------------------------------------------------------------------------

function requireCommandableSession(userId: string, sessionId: string): InteractiveBrowserSessionRow {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  if (row.status === "EXPIRED") throw new AppError("BROWSER_SESSION_EXPIRED");
  if (!COMMANDABLE_SESSION_STATUSES.includes(row.status as never)) {
    throw new AppError("SESSION_NOT_READY", { message: `The browser session is ${row.status.toLowerCase()}.` });
  }
  return row;
}

function requireRuntime(row: InteractiveBrowserSessionRow): { runtime: SessionRuntimeInfo; client: ControlClient } {
  const runtime = parseRuntimeInfo(row);
  if (!runtime) {
    throw new AppError("SESSION_NOT_READY", { message: "The browser runtime is not attached to this session." });
  }
  return { runtime, client: new ControlClient(runtime.controlPort) };
}

function safeUrl(value: string): { ok: true; url?: string } | { ok: false; reason: string } {
  // validateTestUrlWithDns is async (DNS pinning against rebinding); callers
  // await it. This synchronous pre-check trims obviously malformed input.
  if (value.length > 2048) return { ok: false, reason: "The URL is too long." };
  return { ok: true };
}

export async function navigateSession(userId: string, sessionId: string, operation: NavigationOperation): Promise<InteractiveBrowserSessionRow> {
  const row = requireCommandableSession(userId, sessionId);
  const { runtime, client } = requireRuntime(row);

  let currentUrl = row.current_url;
  switch (operation.op) {
    case "navigate": {
      const validated = await validateTestUrlWithDns(operation.url);
      if (!validated.ok || !validated.url) {
        throw new AppError("UNSAFE_URL", { message: validated.reason ?? "This URL cannot be opened in the interactive browser." });
      }
      const response = await client.command("open-url", runtime.runnerToken, { url: validated.url }, 8000);
      if (!response.ok) throw new AppError("UNSAFE_URL", { message: response.message ?? "The URL was rejected by the browser environment." });
      currentUrl = validated.url;
      appendSessionEvent(row.id, {
        type: "navigation",
        message: `Navigated to ${validated.url.slice(0, 180)}`,
        metadata: { url: validated.url.slice(0, 512), op: "navigate" },
      });
      break;
    }
    case "back":
    case "forward": {
      const response = await client.command(operation.op === "back" ? "go-back" : "go-forward", runtime.runnerToken, {}, 6000);
      if (!response.ok) throw new AppError("INVALID_INPUT", { message: response.message ?? "Navigation failed." });
      appendSessionEvent(row.id, { type: "navigation", message: operation.op === "back" ? "Navigated back." : "Navigated forward.", metadata: { op: operation.op } });
      break;
    }
    case "reload": {
      const response = await client.command("reload", runtime.runnerToken, {}, 8000);
      if (!response.ok) throw new AppError("INVALID_INPUT", { message: response.message ?? "Reload failed." });
      appendSessionEvent(row.id, { type: "navigation", message: "Page reloaded.", metadata: { op: "reload" } });
      break;
    }
  }

  touchSessionActivity(row.id);
  const urlProbe = await client.command("get-url", runtime.runnerToken, {}, 4000).catch(() => null);
  const observed: string | null =
    urlProbe?.ok && typeof urlProbe.data?.url === "string" ? (urlProbe.data.url as string) : currentUrl;
  const active = transitionSession(row.id, ["READY", "IDLE", "ACTIVE"], "ACTIVE", {
    currentUrl: observed ? observed.slice(0, 512) : null,
    touchActivity: true,
    stateReason: "Session active.",
  });
  return active ?? getSessionById(row.id)!;
}

export async function sendInput(userId: string, sessionId: string, action: unknown): Promise<{ ok: true }> {
  const row = requireCommandableSession(userId, sessionId);
  const { runtime, client } = requireRuntime(row);
  const hub = getInteractiveHub();
  const info = hubInfo(row);
  if (!info) throw new AppError("SESSION_NOT_READY");
  const bounds = action && typeof action === "object" && (action as { target?: string }).target === "popup" && row.popup_width && row.popup_height
    ? { width: row.popup_width, height: row.popup_height }
    : { width: row.viewport_width, height: row.viewport_height };
  const validated = validateInputAction(action, bounds);
  if (!validated.ok) throw new AppError("INPUT_REJECTED", { message: validated.reason });
  if (!hub.allowInput(info)) {
    throw new AppError("RATE_LIMITED", { message: "Too many input actions. Slow down for a moment." });
  }

  const response = await client.command("input", runtime.runnerToken, { action: validated.action }, 6000);
  if (!response.ok) {
    throw new AppError("INPUT_REJECTED", { message: response.message ?? "The input action was rejected." });
  }
  touchSessionActivity(row.id);
  transitionSession(row.id, ["READY", "IDLE"], "ACTIVE", { stateReason: "Session active.", touchActivity: true });
  return { ok: true };
}

export async function openPopup(userId: string, sessionId: string): Promise<InteractiveBrowserSessionRow> {
  const row = requireCommandableSession(userId, sessionId);
  const extension = parseExtensionInfo(row);
  if (!extension.popupPath) throw new AppError("POPUP_UNAVAILABLE", { message: "This extension does not declare a popup." });
  const { runtime, client } = requireRuntime(row);

  const response = await client.command("open-popup", runtime.runnerToken, { popupPath: extension.popupPath }, 15000);
  if (!response.ok) {
    appendSessionEvent(row.id, { type: "runtime_error", level: "warning", message: response.message ?? "The popup could not be opened." });
    throw new AppError("POPUP_UNAVAILABLE", { message: response.message ?? "The popup could not be opened in the isolated browser." });
  }
  const width = typeof response.data?.width === "number" ? response.data.width : 380;
  const height = typeof response.data?.height === "number" ? response.data.height : 600;
  touchSessionActivity(row.id);
  const updated = transitionSession(row.id, ["READY", "IDLE", "ACTIVE"], "ACTIVE", {
    popupOpen: true,
    popupWidth: width,
    popupHeight: height,
    touchActivity: true,
    stateReason: "Session active.",
  });
  appendSessionEvent(row.id, {
    type: "popup_opened",
    message: "Extension popup opened in the isolated browser.",
    metadata: { width, height },
  });
  recordMetric("interactive.popup_opened", 1);
  return updated ?? getSessionById(row.id)!;
}

export async function closePopup(userId: string, sessionId: string): Promise<InteractiveBrowserSessionRow> {
  const row = requireCommandableSession(userId, sessionId);
  const { runtime, client } = requireRuntime(row);
  await client.command("close-popup", runtime.runnerToken, {}, 6000).catch(() => undefined);
  const updated = transitionSession(row.id, ["READY", "IDLE", "ACTIVE"], "ACTIVE", {
    popupOpen: false,
    popupWidth: null,
    popupHeight: null,
    touchActivity: true,
    stateReason: "Session active.",
  });
  appendSessionEvent(row.id, { type: "popup_closed", message: "Extension popup closed." });
  return updated ?? getSessionById(row.id)!;
}

export async function reloadExtension(userId: string, sessionId: string): Promise<InteractiveBrowserSessionRow> {
  const row = requireCommandableSession(userId, sessionId);
  const { runtime, client } = requireRuntime(row);

  // The reload must resolve the ORIGINAL immutable binding: the stored package
  // must still exist and still hash to the recorded SHA-256. Anything else
  // fails closed — no substitution, ever.
  const pkg = row.package_id ? getOwnedPackage(row.user_id, row.package_id) : null;
  if (!pkg || pkg.sha256 !== row.package_sha256) {
    appendSessionEvent(row.id, {
      type: "runtime_error",
      level: "error",
      message: "The original package is no longer available; the extension cannot be reloaded.",
    });
    await destroyInteractiveSession(getSessionById(row.id)!, getInteractiveDriver(), {
      from: ["READY", "ACTIVE", "IDLE"],
      to: "FAILED",
      stopReason: "package_unavailable",
      stateReason: "The original package is no longer available.",
      events: [{ type: "session_stopped", level: "warning", message: "Session ended: package unavailable." }],
    });
    throw new AppError("PACKAGE_UNAVAILABLE");
  }

  const response = await client.command("restart-extension", runtime.runnerToken, {}, 45000);
  if (!response.ok) {
    appendSessionEvent(row.id, { type: "runtime_error", level: "warning", message: response.message ?? "Extension reload failed." });
    throw new AppError("BROWSER_SESSION_START_FAILED", { message: response.message ?? "The extension could not be reloaded." });
  }
  touchSessionActivity(row.id);
  const updated = transitionSession(row.id, ["READY", "IDLE", "ACTIVE"], "ACTIVE", {
    popupOpen: false,
    popupWidth: null,
    popupHeight: null,
    touchActivity: true,
    stateReason: "Session active.",
  });
  appendSessionEvent(row.id, {
    type: "extension_reloaded",
    message: "Extension reloaded from the original package binding.",
    metadata: { packageSha256: row.package_sha256 },
  });
  recordMetric("interactive.extension_reloaded", 1);
  return updated ?? getSessionById(row.id)!;
}

export async function setSessionViewport(userId: string, sessionId: string, width: unknown, height: unknown): Promise<InteractiveBrowserSessionRow> {
  const row = requireCommandableSession(userId, sessionId);
  const validated = validateViewport(width, height);
  if (!validated.ok) throw new AppError("INVALID_INPUT", { message: validated.reason });
  const { runtime, client } = requireRuntime(row);
  const response = await client.command("set-viewport", runtime.runnerToken, validated, 6000);
  if (!response.ok) throw new AppError("INVALID_INPUT", { message: response.message ?? "The viewport could not be changed." });
  const updated = transitionSession(row.id, ["READY", "IDLE", "ACTIVE"], "ACTIVE", {
    viewportWidth: validated.width,
    viewportHeight: validated.height,
    touchActivity: true,
    stateReason: "Session active.",
  });
  appendSessionEvent(row.id, {
    type: "viewport_changed",
    message: `Viewport set to ${validated.width}×${validated.height}.`,
    metadata: { width: validated.width, height: validated.height },
  });
  return updated ?? getSessionById(row.id)!;
}

/** Authenticated keepalive; never extends the hard lifetime deadline. */
export function keepaliveSession(userId: string, sessionId: string): InteractiveBrowserSessionRow {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  if (["STOPPED", "EXPIRED", "FAILED"].includes(row.status)) {
    throw new AppError("BROWSER_SESSION_EXPIRED", { message: `The session has ended (${row.stop_reason ?? row.status.toLowerCase()}).` });
  }
  touchSessionActivity(row.id);
  return getSessionById(row.id)!;
}

// ---------------------------------------------------------------------------
// Evidence: frames, artifacts, console, network, events
// ---------------------------------------------------------------------------

export async function captureFrame(userId: string, sessionId: string, target: "page" | "popup"): Promise<{ bytes: Uint8Array } | null> {
  const row = requireCommandableSession(userId, sessionId);
  if (target === "popup" && row.popup_open !== 1) return null;
  const info = hubInfo(row);
  if (!info) throw new AppError("SESSION_NOT_READY");
  const hub = getInteractiveHub();
  const frame = await hub.captureFrame(info, target);
  return frame ? { bytes: frame.bytes } : null;
}

export async function captureScreenshotArtifact(userId: string, sessionId: string, label?: string | null): Promise<ScreenshotArtifactView> {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  const config = getConfig().interactiveBrowser;
  if (row.artifact_count >= config.maxArtifactsPerSession) {
    throw new AppError("QUOTA_EXCEEDED", { message: `This session already captured the maximum of ${config.maxArtifactsPerSession} screenshots.` });
  }
  const frame = await captureFrame(userId, sessionId, "page");
  if (!frame || frame.bytes.byteLength === 0) {
    throw new AppError("SESSION_NOT_READY", { message: "No browser frame is available yet." });
  }
  if (frame.bytes.byteLength > config.maxFrameBytes) {
    throw new AppError("INVALID_INPUT", { message: "The captured frame exceeds the size limit." });
  }

  const storage = getStorage();
  const key = artifactStorageKey(sessionId, "png");
  await storage.put(key, frame.bytes, { contentType: "image/png" });
  const stored = await storage.get(key);
  const sha256 = sha256Hex(stored);
  if (stored.byteLength !== frame.bytes.byteLength || sha256 !== sha256Hex(frame.bytes)) {
    await storage.delete(key).catch(() => undefined);
    throw new AppError("STORAGE_ERROR", { message: "The screenshot could not be stored." });
  }
  const retention = getRetentionForUser(userId);
  const artifact = createSessionArtifactRecord({
    sessionId,
    userId,
    storageKey: key,
    size: stored.byteLength,
    sha256,
    contentType: "image/png",
    label: label?.slice(0, 120) ?? null,
    packageVersion: row.package_version,
    packageSha256: row.package_sha256,
    browser: row.browser,
    browserVersion: row.browser_version,
    expiresAt: Date.now() + retention.artifactRetentionMs,
  });
  transitionSession(sessionId, ["READY", "IDLE", "ACTIVE", "STOPPING", "CREATED", "QUEUED", "STARTING"], row.status as InteractiveSessionStatus, {
    artifactCount: row.artifact_count + 1,
  });
  appendSessionEvent(sessionId, {
    type: "screenshot_captured",
    message: "Screenshot captured as an artifact.",
    metadata: { artifactId: artifact.id },
  });
  return {
    id: artifact.id,
    label: artifact.label,
    size: artifact.size,
    createdAt: artifact.created_at,
    expiresAt: artifact.expires_at,
    url: `/api/browser-sessions/${sessionId}/artifacts/${artifact.id}`,
  };
}

export function listSessionArtifactViews(userId: string, sessionId: string): ScreenshotArtifactView[] {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  return listSessionArtifacts(sessionId).map((artifact) => ({
    id: artifact.id,
    label: artifact.label,
    size: artifact.size,
    createdAt: artifact.created_at,
    expiresAt: artifact.expires_at,
    url: `/api/browser-sessions/${sessionId}/artifacts/${artifact.id}`,
  }));
}

export function getConsoleEntries(userId: string, sessionId: string): { entries: ConsoleEntryView[] } {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  const info = hubInfo(row);
  if (!info) return { entries: [] };
  return { entries: getInteractiveHub().getConsole(info) };
}

export function getNetworkEntries(userId: string, sessionId: string): { entries: NetworkEntryView[] } {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  const info = hubInfo(row);
  if (!info) return { entries: [] };
  return { entries: getInteractiveHub().getNetwork(info) };
}

export function getSessionEventViews(userId: string, sessionId: string, afterSeq = 0): InteractiveSessionEventView[] {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  return listSessionEvents(sessionId, afterSeq).map(toEventView);
}

export function getSessionViewForUser(userId: string, sessionId: string): InteractiveBrowserSessionView {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  return toSessionView(row);
}

// ---------------------------------------------------------------------------
// Driver access (shared with the job handlers; injectable for tests)
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __extensionlabInteractiveDriver: SandboxDriver | undefined;
}

export function getInteractiveDriver(): SandboxDriver {
  if (globalThis.__extensionlabInteractiveDriver) return globalThis.__extensionlabInteractiveDriver;
  const driver = createDockerDriver();
  globalThis.__extensionlabInteractiveDriver = driver;
  return driver;
}

export function setInteractiveDriverForTests(driver: SandboxDriver | null): void {
  globalThis.__extensionlabInteractiveDriver = driver ?? undefined;
}

export { getInteractiveBrowserConcurrency as getInteractiveHubConcurrencyLimit };
