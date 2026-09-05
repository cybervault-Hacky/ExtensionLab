import { createAIRoute, optionalId } from "@/lib/ai/route-handler";
import { AIError } from "@/lib/ai/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/suggest-tests — validated test suggestions for a report or an
 * analysis snapshot the caller owns. Suggestions are data: every generated
 * test passes the test-engine allowlists before it is returned, and nothing
 * is executed.
 * Body: { reportId } or { snapshotId }
 */
export const POST = createAIRoute({
  feature: "suggest_tests",
  parse(body) {
    const reportId = optionalId(body, "reportId");
    const snapshotId = optionalId(body, "snapshotId");
    if (reportId) return { resource: { kind: "report", id: reportId }, targetId: null };
    if (snapshotId) return { resource: { kind: "snapshot", id: snapshotId }, targetId: null };
    throw new AIError("INVALID_INPUT", { message: "reportId or snapshotId is required." });
  },
});
