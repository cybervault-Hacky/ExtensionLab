import "server-only";
import { isSafeId } from "@/lib/auth/validation";
import { getOwnedReport } from "@/lib/db/repositories/reports";
import { getOwnedTestRun } from "@/lib/db/repositories/test-runs";
import { getOwnedSnapshot } from "@/lib/db/repositories/snapshots";
import { getOwnedExtension } from "@/lib/db/repositories/extensions";
import { listOwnedRunArtifacts, readOwnedArtifact } from "@/lib/artifacts/service";
import type { ExtensionAnalysis } from "@/types/extension";
import type { DiagnosticFinding } from "@/lib/testing/types";
import type { ContextSource, NetworkSummaryLike, ReportJsonLike, RunJsonLike, RuntimeLogLike } from "./context";
import { AIError } from "./errors";

/**
 * Owner-scoped loaders. Every loader goes through the Phase 5 `getOwned*`
 * repositories, so a resource that belongs to another user — or a public
 * share token, which never carries a session — resolves to
 * AI_UNAUTHORIZED_CONTEXT (rendered as 404, exactly like the private APIs).
 */

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function loadReportSource(userId: string, reportId: string): ContextSource {
  if (!isSafeId(reportId)) throw new AIError("AI_UNAUTHORIZED_CONTEXT");
  const report = getOwnedReport(userId, reportId);
  if (!report) throw new AIError("AI_UNAUTHORIZED_CONTEXT");
  const json = parseJson<ReportJsonLike>(report.report_json);
  const snapshot = report.analysis_snapshot_id ? getOwnedSnapshot(userId, report.analysis_snapshot_id) : null;
  const analysis = snapshot ? parseJson<ExtensionAnalysis>(snapshot.analysis_json) : null;
  const run = report.test_run_id ? getOwnedTestRun(userId, report.test_run_id) : null;
  return {
    resource: { kind: "report", id: report.id },
    extension: {
      name: report.extensionName ?? (typeof json?.extension?.name === "string" ? json.extension.name : null),
      version: report.extensionVersion ?? (typeof json?.extension?.version === "string" ? json.extension.version : null),
      manifestVersion: typeof json?.extension?.manifestVersion === "string" ? json.extension.manifestVersion : null,
    },
    analysis,
    report: json,
    run: run
      ? {
          row: run,
          json: parseJson<RunJsonLike>(run.result_json),
          diagnostics: parseJson<DiagnosticFinding[]>(run.diagnostics_json),
        }
      : null,
  };
}

/** Includes the runtime log / network summary artifacts when `withRuntimeEvidence` is set. */
export async function loadTestRunSource(userId: string, runId: string, withRuntimeEvidence = false): Promise<ContextSource> {
  if (!isSafeId(runId)) throw new AIError("AI_UNAUTHORIZED_CONTEXT");
  const run = getOwnedTestRun(userId, runId);
  if (!run) throw new AIError("AI_UNAUTHORIZED_CONTEXT");
  const extension = run.extension_id ? getOwnedExtension(userId, run.extension_id) : null;
  let runtimeLog: RuntimeLogLike | null = null;
  let network: NetworkSummaryLike | null = null;
  if (withRuntimeEvidence) {
    for (const artifact of listOwnedRunArtifacts(userId, run.id)) {
      if (artifact.type !== "runtime-log" && artifact.type !== "network-summary") continue;
      const loaded = await readOwnedArtifact(userId, artifact.id);
      if (!loaded) continue;
      const parsed = parseJson<Record<string, unknown>>(new TextDecoder().decode(loaded.bytes));
      if (!parsed) continue;
      if (artifact.type === "runtime-log") runtimeLog = parsed as RuntimeLogLike;
      else network = parsed as NetworkSummaryLike;
    }
  }
  return {
    resource: { kind: "test_run", id: run.id },
    extension: {
      name: run.extensionName ?? extension?.name ?? null,
      version: run.extensionVersion ?? extension?.version ?? null,
      manifestVersion: extension?.manifest_version ?? null,
    },
    analysis: null,
    report: null,
    run: {
      row: run,
      json: parseJson<RunJsonLike>(run.result_json),
      diagnostics: parseJson<DiagnosticFinding[]>(run.diagnostics_json),
      runtimeLog,
      network,
    },
  };
}

export function loadSnapshotSource(userId: string, snapshotId: string): ContextSource {
  if (!isSafeId(snapshotId)) throw new AIError("AI_UNAUTHORIZED_CONTEXT");
  const snapshot = getOwnedSnapshot(userId, snapshotId);
  if (!snapshot) throw new AIError("AI_UNAUTHORIZED_CONTEXT");
  const extension = getOwnedExtension(userId, snapshot.extension_id);
  const analysis = parseJson<ExtensionAnalysis>(snapshot.analysis_json);
  return {
    resource: { kind: "snapshot", id: snapshot.id },
    extension: {
      name: extension?.name ?? analysis?.metadata?.name ?? null,
      version: extension?.version ?? analysis?.metadata?.version ?? null,
      manifestVersion: extension?.manifest_version ?? snapshot.manifest_version,
    },
    analysis,
    report: null,
    run: null,
  };
}
