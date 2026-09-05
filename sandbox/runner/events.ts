import { randomBytes } from "node:crypto";

export interface RunnerEvent {
  id: string;
  timestamp: number;
  type: "sandbox" | "browser" | "extension" | "console" | "network" | "page" | "error";
  level: "debug" | "info" | "log" | "warning" | "error";
  source: string;
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
}

type Listener = (event: RunnerEvent) => void;

export class EventHub {
  private listeners = new Set<Listener>();
  private recent: RunnerEvent[] = [];

  emit(input: Omit<RunnerEvent, "id" | "timestamp">): RunnerEvent {
    const event: RunnerEvent = {
      id: randomBytes(8).toString("hex"),
      timestamp: Date.now(),
      ...input,
    };
    this.recent.push(event);
    if (this.recent.length > 600) this.recent.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Event listeners must never break the runner.
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRecent(): RunnerEvent[] {
    return [...this.recent];
  }
}
