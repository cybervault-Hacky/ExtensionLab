import { createAIRoute, requiredId, requiredTargetId } from "@/lib/ai/route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/test-failure — "Analyze failure" for one test inside one of the
 * caller's automated test runs. Runtime log / network artifacts are included
 * when the owner's plan can access them (they are read through the owner-only
 * artifact service).
 * Body: { runId, testId }
 */
export const POST = createAIRoute({
  feature: "explain_test_failure",
  parse(body) {
    const runId = requiredId(body, "runId");
    const testId = requiredTargetId(body, "testId");
    return { resource: { kind: "test_run", id: runId, withRuntimeEvidence: true }, focus: { testId }, targetId: testId };
  },
});
