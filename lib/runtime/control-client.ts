import "server-only";
import type { RuntimeEvent, SandboxAction } from "@/types/runtime";
import { truncate } from "./redact";
import { cleanRuntimeText } from "./security";

/**
 * HTTP client for the container-local control server.
 *
 * The control server only runs on loopback inside the host API process. It
 * exposes a single ephemeral HTTP port per sandbox and accepts only predefined
 * actions.
 */

export interface ControlCommand {
  ok: boolean;
  status: string;
  message?: string;
}

export class ControlClient {
  constructor(private readonly port: number) {}

  private baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async health(timeoutMs = 3000): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`${this.baseUrl()}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }

  async command(
    action: SandboxAction,
    token: string,
    payload?: Record<string, unknown>,
    timeoutMs = 4000,
  ): Promise<ControlCommand> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${this.baseUrl()}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandbox-token": token,
      },
      body: JSON.stringify({ command: action, payload }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return {
        ok: false,
        status: "failed",
        message: "The sandbox runner rejected the command.",
      };
    }
    return (await response.json()) as ControlCommand;
  }

  /**
   * Open an SSE stream against the sandbox runner and re-publish raw runtime
   * events into the host-side EventEmitter.
   */
  async streamEvents(
    token: string,
    onEvent: (event: RuntimeEvent) => void,
    onClose: () => void,
  ): Promise<() => void> {
    const controller = new AbortController();
    let buffer = "";

    const response = await fetch(
      `${this.baseUrl()}/events?token=${encodeURIComponent(token)}`,
      { signal: controller.signal },
    );

    if (!response.ok || !response.body) {
      onClose();
      return () => controller.abort();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const pump = async (): Promise<void> => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const block of lines) {
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as RuntimeEvent;
              if (isSafeRuntimeEvent(parsed)) {
                onEvent(sanitizeRuntimeEvent(parsed));
              }
            } catch {
              // Ignore malformed sandbox frames.
            }
          }
        }
      } catch {
        // Stream closed or aborted.
      } finally {
        onClose();
      }
    };

    void pump();
    return () => controller.abort();
  }

  async screenshot(token: string, timeoutMs = 6000): Promise<Uint8Array | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${this.baseUrl()}/screenshot`, {
      headers: { "x-sandbox-token": token },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  }
}

function isSafeRuntimeEvent(event: RuntimeEvent): boolean {
  return (
    Boolean(event.id) &&
    typeof event.timestamp === "number" &&
    ["sandbox", "browser", "extension", "console", "network", "page", "error"].includes(
      event.type,
    )
  );
}

function sanitizeRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    level: event.level,
    source: cleanRuntimeText(event.source ?? "").slice(0, 128),
    message: cleanRuntimeText(event.message ?? "").slice(0, 2000),
    metadata: event.metadata ?? undefined,
  };
}
