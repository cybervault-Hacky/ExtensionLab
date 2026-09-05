import { createAIRoute, requiredId } from "@/lib/ai/route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/runtime-error — analysis of the runtime errors, warnings and
 * failed requests captured during one of the caller's test runs.
 * Body: { runId }
 */
export const POST = createAIRoute({
  feature: "analyze_runtime_error",
  parse(body) {
    const runId = requiredId(body, "runId");
    return { resource: { kind: "test_run", id: runId, withRuntimeEvidence: true }, targetId: null };
  },
});
