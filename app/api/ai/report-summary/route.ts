import { createAIRoute, requiredId } from "@/lib/ai/route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/report-summary — "Generate AI Summary" for one of the caller's reports.
 * Body: { reportId }
 */
export const POST = createAIRoute({
  feature: "summarize_report",
  parse(body) {
    const reportId = requiredId(body, "reportId");
    return { resource: { kind: "report", id: reportId }, targetId: null };
  },
});
