import type { NextRequest } from "next/server";
import { getSandboxToken } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { getTestRunById } from "@/lib/db/repositories/test-runs";
import { buildRunInfo, isRunActive, listRunEvents, resolveAccessibleRun } from "@/lib/testing/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 750;
const HEARTBEAT_MS = 15000;
const MAX_STREAM_MS = 30 * 60 * 1000;

/**
 * Server-sent events backed by the durable job event log. Clients may
 * reconnect with `Last-Event-ID` (or `?after=`) and resume without losing
 * stage transitions or test results — the run lives in the database, not in
 * the web process.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await context.params;
  let initialAfter = 0;
  try {
    const user = requireApiUser(request);
    if (!isSafeId(runId)) throw new AppError("NOT_FOUND", { message: "Test run was not found." });
    resolveAccessibleRun(user.id, runId, getSandboxToken(request));
    const header = request.headers.get("last-event-id");
    const query = new URL(request.url).searchParams.get("after");
    const candidate = Number(header ?? query ?? "0");
    initialAfter = Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : 0;
  } catch (error) {
    return apiErrorResponse(error, request);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let after = initialAfter;
      let closed = false;
      let idleTicks = 0;
      const startedAt = Date.now();

      const send = (payload: string, id?: number) => {
        if (closed) return;
        const idLine = id !== undefined ? `id: ${id}\n` : "";
        controller.enqueue(encoder.encode(`${idLine}data: ${payload}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const pump = () => {
        if (closed) return;
        const run = getTestRunById(runId);
        if (!run) {
          send(JSON.stringify({ type: "state", state: "failed", reason: "Test run was not found." }));
          close();
          return;
        }
        const events = listRunEvents(run, after);
        for (const event of events) {
          send(event.payload, event.id);
          after = event.id;
        }
        if (!isRunActive(run)) {
          idleTicks += 1;
          // Allow one extra tick so trailing events written after the status flip are flushed.
          if (idleTicks >= 2) {
            send(JSON.stringify({ type: "done", info: buildRunInfo(run) }));
            close();
          }
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
