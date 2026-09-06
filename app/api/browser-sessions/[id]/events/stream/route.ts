import { NextRequest } from "next/server";
import { apiErrorResponse, badRequest, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { getSessionById, getOwnedSession, isTerminalSessionStatus } from "@/lib/db/repositories/browser-sessions";
import { getSessionEventViews, hubInfo, toSessionView } from "@/lib/interactive/service";
import { getInteractiveHub } from "@/lib/interactive/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live workspace stream (SSE, Phase 11).
 *
 * Replay is snapshot-based: the client first receives the current session
 * state, console/network rings and durable events, then live frames from the
 * container event stream. On disconnect the session keeps running; the client
 * reconnects to the SAME session (a new one is never created implicitly).
 *
 * Durable state changes are observed by polling the session row (cheap and
 * correct with multiple web replicas); runtime frames fan out through the
 * process-local hub, which re-attaches to the container as needed.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let sessionId = "";
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    sessionId = id;
    if (!isSafeId(id)) throw badRequest("Invalid session id.");
    const initial = getOwnedSession(user.id, id);
    if (!initial) throw new AppError("BROWSER_SESSION_NOT_FOUND", { message: "Browser session not found." });
  } catch (error) {
    return apiErrorResponse(error, request);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // --- Snapshot replay -------------------------------------------------
      const initialRow = getSessionById(sessionId);
      if (initialRow) {
        send("state", toSessionView(initialRow));
        const info = hubInfo(initialRow);
        if (info) {
          send("console", { entries: getInteractiveHub().getConsole(info) });
          send("network", { entries: getInteractiveHub().getNetwork(info) });
        }
        send("events", { events: getSessionEventViews(initialRow.user_id, sessionId, 0) });
      }

      // --- Live frames -----------------------------------------------------
      const liveRow = getSessionById(sessionId);
      const liveInfo = liveRow ? hubInfo(liveRow) : null;
      const unsubscribe = liveInfo
        ? getInteractiveHub().subscribe(liveInfo, (frame) => send(frame.kind, frame.payload))
        : () => undefined;

      // --- Durable state changes --------------------------------------------
      let lastStatus = initialRow?.status ?? "";
      const statePoll = setInterval(() => {
        const row = getSessionById(sessionId);
        if (!row) return;
        if (row.status !== lastStatus) {
          lastStatus = row.status;
          send("state", toSessionView(row));
        }
        if (isTerminalSessionStatus(row.status)) {
          send("events", { events: getSessionEventViews(row.user_id, sessionId, 0) });
          cleanup();
        }
      }, 1500);

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15000);

      function cleanup(): void {
        if (closed) return;
        closed = true;
        clearInterval(statePoll);
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }

      request.signal.addEventListener("abort", cleanup);
      if (initialRow && isTerminalSessionStatus(initialRow.status)) cleanup();
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
