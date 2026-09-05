import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { getOwnedMatrixRun, listExecutionsForMatrix } from "@/lib/db/repositories/browser-matrix";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { sweepExecutionsFromRuns } from "@/lib/testing/matrix-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;
const MAX_STREAM_MS = 15 * 60 * 1000;

/**
 * Matrix SSE: reuses the durable database state. Emits per-browser lifecycle
 * events (queued → starting → running → completed/failed/skipped) plus test
 * progress from the child runs, then a final aggregate event. Reconnects are
 * safe: the matrix and its executions live in the database.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await context.params;
  const auth = (() => {
    try {
      return requireApiUser(request);
    } catch {
      return null;
    }
  })();
  if (!auth) return apiErrorResponse(new AppError("AUTH_REQUIRED"), request);
  const user = auth;
  if (!isSafeId(runId)) return apiErrorResponse(new AppError("NOT_FOUND", { message: "Matrix run was not found." }), request);
  if (!getOwnedMatrixRun(user.id, runId)) {
    return apiErrorResponse(new AppError("NOT_FOUND", { message: "Matrix run was not found." }), request);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSignature = "";
      const startedAt = Date.now();

      const send = (payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const aggregate = () => {
        // Reconcile finished child runs onto execution rows (idempotent).
        sweepExecutionsFromRuns(runId);
        const executions = listExecutionsForMatrix(runId);
        const browsers = executions.map((execution) => {
          const run = getTestRunById(execution.test_run_id);
          const stage = run?.stage ?? null;
          return {
            browserId: execution.browser_id,
            status: execution.status,
            stage,
            outcome: execution.outcome ?? run?.outcome ?? null,
            score: execution.score ?? run?.score ?? null,
            passed: execution.passed,
            failed: execution.failed,
            skipped: execution.skipped,
            runId: execution.test_run_id,
          };
        });
        const signature = JSON.stringify({
          matrix: getOwnedMatrixRun(user.id, runId)?.status ?? "unknown",
          browsers: browsers.map((browser) => [browser.browserId, browser.status, browser.stage, browser.outcome, browser.score, browser.passed, browser.failed]),
        });
        const changed = signature !== lastSignature;
        lastSignature = signature;
        return { browsers, changed, matrix: getOwnedMatrixRun(user.id, runId) };
      };

      const pump = () => {
        if (closed) return;
        const { browsers, changed, matrix } = aggregate();
        if (!matrix) {
          send({ type: "error", reason: "Matrix run was not found." });
          close();
          return;
        }
        if (changed) {
          send({
            type: "matrix",
            status: matrix.status,
            compatibilityScore: matrix.compatibility_score,
            browsers,
          });
        }
        if (["completed", "partial", "failed", "cancelled"].includes(matrix.status)) {
          send({ type: "done", status: matrix.status, browsers });
          close();
        } else if (Date.now() - startedAt > MAX_STREAM_MS) {
          close();
        }
      };

      const poll = setInterval(pump, POLL_MS);
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
      }, HEARTBEAT_MS);
      request.signal.addEventListener("abort", close);
      pump();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
