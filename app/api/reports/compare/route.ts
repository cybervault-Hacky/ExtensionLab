import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser } from "@/lib/auth/api";
import { getReportsForComparison } from "@/lib/db/repositories/reports";
import type { ReportWithExtension } from "@/lib/db/repositories/reports";
import { isSafeId } from "@/lib/auth/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const url = new URL(request.url);
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    if (!a || !b || !isSafeId(a) || !isSafeId(b)) {
      throw badRequest("Two valid report ids are required.");
    }
    const reports = getReportsForComparison(user.id, [a, b]);
    if (reports.length !== 2) throw badRequest("Two reports owned by your account are required.");

    const [left, right] = reports;
    const payload = {
      before: summarizeReport(left),
      after: summarizeReport(right),
      rows: buildRows(left, right),
      changes: buildChanges(left, right),
    };
    return NextResponse.json(payload);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function summarizeReport(report: ReportWithExtension) {
  return {
    id: report.id,
    title: report.title,
    extensionName: report.extensionName,
    healthScore: report.health_score,
    runtimeScore: report.runtime_score,
    overallScore: report.overall_score,
    createdAt: report.created_at,
  };
}

function buildRows(before: ReportWithExtension, after: ReportWithExtension) {
  const rows: Array<{
    field: string;
    label: string;
    before: number | null;
    after: number | null;
    direction: "improved" | "worsened" | "unchanged";
  }> = [];
  rows.push(row("Health", "Health Score", before.health_score, after.health_score));
  rows.push(row("Runtime", "Runtime Score", before.runtime_score, after.runtime_score));
  if (before.runtime_score !== null && after.runtime_score !== null) {
    const beforeJson = before.report_json ? JSON.parse(before.report_json) : null;
    const afterJson = after.report_json ? JSON.parse(after.report_json) : null;
    const beforeSummary = (beforeJson?.runtimeTests as Record<string, unknown>)?.summary as Record<string, unknown> | undefined;
    const afterSummary = (afterJson?.runtimeTests as Record<string, unknown>)?.summary as Record<string, unknown> | undefined;
    const count = (key: string, source?: Record<string, unknown>) => Number(source?.[key] ?? 0);
    rows.push(row("Passed", "Passed Tests", count("passed", beforeSummary), count("passed", afterSummary)));
    rows.push(row("Failed", "Failed Tests", count("failed", beforeSummary), count("failed", afterSummary), true));
    rows.push(row("Warnings", "Warnings", count("warnings", beforeSummary), count("warnings", afterSummary), true));
  }
  return rows;
}

function row(
  field: string,
  label: string,
  before: number | null,
  after: number | null,
  invert = false,
): { field: string; label: string; before: number | null; after: number | null; direction: "improved" | "worsened" | "unchanged" } {
  const diff = (after ?? 0) - (before ?? 0);
  let direction: "improved" | "worsened" | "unchanged" = "unchanged";
  if (diff !== 0) {
    const rawGood = diff > 0;
    direction = invert ? (rawGood ? "worsened" : "improved") : rawGood ? "improved" : "worsened";
  }
  return { field, label, before, after, direction };
}

function buildChanges(before: ReportWithExtension, after: ReportWithExtension) {
  const changes: Array<{ label: string; value: string; direction: "improved" | "worsened" | "unchanged"; field: string }> = [];
  changes.push(change("Health", before.health_score, after.health_score));
  changes.push(change("Runtime", before.runtime_score, after.runtime_score));
  if (before.runtime_score !== null && after.runtime_score !== null) {
    const beforeJson = before.report_json ? JSON.parse(before.report_json) : null;
    const afterJson = after.report_json ? JSON.parse(after.report_json) : null;
    const beforeSummary = (beforeJson?.runtimeTests as Record<string, unknown>)?.summary as Record<string, unknown> | undefined;
    const afterSummary = (afterJson?.runtimeTests as Record<string, unknown>)?.summary as Record<string, unknown> | undefined;
    const count = (key: string, source?: Record<string, unknown>) => Number(source?.[key] ?? 0);
    changes.push(change("Passed tests", count("passed", beforeSummary), count("passed", afterSummary)));
    changes.push(change("Failed tests", count("failed", beforeSummary), count("failed", afterSummary), true));
    changes.push(change("Warnings", count("warnings", beforeSummary), count("warnings", afterSummary), true));
  }
  return changes;
}

function change(
  label: string,
  before: number | null,
  after: number | null,
  invert = false,
): { label: string; value: string; direction: "improved" | "worsened" | "unchanged"; field: string } {
  const diff = (after ?? 0) - (before ?? 0);
  const value = diff === 0 ? "No change" : `${diff > 0 ? "+" : ""}${diff}`;
  let direction: "improved" | "worsened" | "unchanged" = "unchanged";
  if (diff !== 0) {
    const rawGood = diff > 0;
    direction = invert ? (rawGood ? "worsened" : "improved") : rawGood ? "improved" : "worsened";
  }
  return { label, value, direction, field: label };
}
