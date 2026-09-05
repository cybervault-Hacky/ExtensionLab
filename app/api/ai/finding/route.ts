import { createAIRoute, requiredId, requiredTargetId } from "@/lib/ai/route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/finding — "Explain with AI" for a static finding or runtime
 * diagnostic inside one of the caller's reports.
 * Body: { reportId, findingId }
 */
export const POST = createAIRoute({
  feature: "explain_finding",
  parse(body) {
    const reportId = requiredId(body, "reportId");
    const findingId = requiredTargetId(body, "findingId");
    return { resource: { kind: "report", id: reportId }, focus: { findingId }, targetId: findingId };
  },
});
