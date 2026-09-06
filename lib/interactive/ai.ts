import "server-only";
import { AppError } from "@/lib/observability/errors";
import { runAIFeature } from "@/lib/ai/service";
import { getConsoleEntries, getNetworkEntries } from "./service";
import { getOwnedSession, listSessionEvents } from "@/lib/db/repositories/browser-sessions";
import type { AIResponseEnvelope } from "@/lib/ai/types";
import type { InteractiveBrowserSessionRow } from "@/lib/db/schema/types";

/**
 * Phase 12 AI layer for interactive sessions.
 *
 * AI is an OPTIONAL EXPLANATION layer only. It receives a minimized,
 * redacted, bounded projection of session evidence and can never control the
 * browser, execute anything, or turn an unverified inference into a verified
 * fact — verified facts come exclusively from the runtime evidence the
 * workspace already shows, and the response envelope keeps "AI interpretation"
 * separate with its own disclaimer.
 */

const MAX_AI_CONSOLE_ENTRIES = 12;
const MAX_AI_NETWORK_ENTRIES = 10;
const MAX_AI_EVENTS = 15;

/** Loads the session with ownership enforced; the AI never sees another tenant's data. */
function ownedSession(userId: string, sessionId: string): InteractiveBrowserSessionRow {
  const row = getOwnedSession(userId, sessionId);
  if (!row) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  return row;
}

/** Minimized + bounded console projection for the model. */
function consoleProjection(userId: string, sessionId: string) {
  const entries = getConsoleEntries(userId, sessionId).entries;
  const errors = entries.filter((entry) => entry.level === "error" || entry.level === "warning");
  const chosen = (errors.length > 0 ? errors : entries).slice(-MAX_AI_CONSOLE_ENTRIES);
  return chosen.map((entry) => ({
    timestamp: entry.timestamp,
    type: "console",
    level: entry.level,
    source: entry.source,
    message: entry.message.slice(0, 400),
  }));
}

function networkProjection(userId: string, sessionId: string) {
  const entries = getNetworkEntries(userId, sessionId).entries;
  const failing = entries.filter((entry) => entry.status !== null && entry.status >= 400);
  const chosen = (failing.length > 0 ? failing : entries).slice(-MAX_AI_NETWORK_ENTRIES);
  return chosen.map((entry) => ({
    timestamp: entry.timestamp,
    method: entry.method,
    url: entry.url.slice(0, 300),
    status: entry.status,
    resourceType: entry.resourceType,
  }));
}

function sessionSource(userId: string, sessionId: string) {
  const row = ownedSession(userId, sessionId);
  const consoleEntries = consoleProjection(userId, sessionId);
  const networkEntries = networkProjection(userId, sessionId);
  const events = listSessionEvents(sessionId, 0)
    .slice(-MAX_AI_EVENTS)
    .map((event) => ({
      timestamp: event.created_at,
      type: event.type,
      level: event.level,
      source: "session",
      message: event.message.slice(0, 300),
    }));
  const errorCount = consoleEntries.filter((entry) => entry.level === "error").length;
  const warningCount = consoleEntries.filter((entry) => entry.level === "warning").length;
  return { row, consoleEntries, networkEntries, events, errorCount, warningCount };
}

function extensionContext(row: InteractiveBrowserSessionRow) {
  let name: string | null = null;
  let manifestVersion: string | null = null;
  try {
    const parsed = JSON.parse(row.extension_info_json) as { name?: string; manifestVersion?: string };
    name = parsed.name ?? null;
    manifestVersion = parsed.manifestVersion ?? null;
  } catch {
    // Panel metadata is optional.
  }
  return {
    name,
    version: row.package_version,
    manifestVersion,
  };
}

/** "Explain Error with AI" — a bounded, redacted runtime-error explanation. */
export async function explainSessionError(
  requestId: string,
  userId: string,
  sessionId: string,
  entryId: string | null,
): Promise<AIResponseEnvelope> {
  const { row, consoleEntries } = sessionSource(userId, sessionId);
  const focused = entryId ? consoleEntries.find((entry) => entry.message.includes(entryId.slice(0, 24))) : null;
  const runtimeLog = {
    events: focused ? [focused, ...consoleEntries.filter((entry) => entry !== focused)] : consoleEntries,
  };
  return runAIFeature({
    requestId,
    userId,
    feature: "analyze_runtime_error",
    source: {
      resource: { kind: "browser_session", id: sessionId },
      extension: extensionContext(row),
      analysis: null,
      report: null,
      run: {
        row: {
          id: sessionId,
          status: row.status,
          outcome: row.stop_reason ?? undefined,
          reason: row.state_reason ?? null,
          total: 0,
          passed: 0,
          failed: 0,
          warnings: consoleEntries.filter((entry) => entry.level === "warning").length,
          skipped: 0,
          timeout: 0,
          error_count: consoleEntries.filter((entry) => entry.level === "error").length,
          score: 0,
        },
        json: null,
        diagnostics: null,
        runtimeLog,
        network: { requests: networkProjection(userId, sessionId) },
      },
    },
    targetId: entryId,
  });
}

/** "Summarize Session" — verified evidence counts plus AI interpretation. */
export async function summarizeSession(
  requestId: string,
  userId: string,
  sessionId: string,
): Promise<AIResponseEnvelope> {
  const { row, consoleEntries, networkEntries, events, errorCount, warningCount } = sessionSource(userId, sessionId);
  return runAIFeature({
    requestId,
    userId,
    feature: "summarize_report",
    source: {
      resource: { kind: "browser_session", id: sessionId },
      extension: extensionContext(row),
      analysis: null,
      report: null,
      run: {
        row: {
          id: sessionId,
          status: row.status,
          outcome: row.stop_reason ?? undefined,
          reason: row.state_reason ?? null,
          total: events.length,
          passed: events.filter((event) => event.type === "extension_loaded").length,
          failed: errorCount,
          warnings: warningCount,
          skipped: 0,
          timeout: 0,
          error_count: errorCount,
          score: 0,
        },
        json: null,
        diagnostics: null,
        runtimeLog: { events },
        network: { requests: networkEntries },
      },
    },
  });
}
