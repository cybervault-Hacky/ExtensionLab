import { getLiveShareByToken } from "./shares";
import { getReportById } from "./reports";
import { createPublicReportView } from "@/lib/reports/views";

export function getSharedPublicReport(token: string) {
  if (!token || token.length < 20) return null;
  const share = getLiveShareByToken(token);
  if (!share) return null;
  const report = getReportById(share.report_id);
  if (!report) return null;
  const payload = report.report_json ? JSON.parse(report.report_json) : null;
  return createPublicReportView(report, payload);
}
