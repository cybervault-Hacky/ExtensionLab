import { NextRequest } from "next/server";
import { getTestRunManager } from "@/lib/testing/manager-instance";
import { getSandboxToken } from "@/lib/runtime/api-helpers";
import { apiErrorResponse, requireApiUser } from "@/lib/auth/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await context.params;
  const token = getSandboxToken(request);
  const manager = getTestRunManager();
  try {
    requireApiUser(request);
    manager.getStatus(runId, token);
  } catch (error) {
    return apiErrorResponse(error);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const unsubscribe = manager.subscribe(runId, token, (event) => {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      });
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(`: ping\n\n`)), 15000);
      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* closed */ }
      });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
