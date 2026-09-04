import { getSandboxConfig } from "./config";
import { generateEventId } from "./ids";
import { truncate } from "./redact";
import type {
  NetworkEntry,
  RuntimeEvent,
  RuntimeEventLevel,
  RuntimeEventType,
} from "@/types/runtime";

/**
 * Bounded runtime event buffer.
 *
 * A malicious extension must not be able to grow application memory without
 * limits. Once the configured event limit is reached, additional events are
 * counted as suppressed but never crash the sandbox.
 */
export class RuntimeEventBuffer {
  private readonly events: RuntimeEvent[] = [];
  private networkEntries: NetworkEntry[] = [];
  private suppressedEvents = 0;
  private readonly maxEvents: number;
  private readonly maxEventSize: number;
  private readonly maxLogLength: number;
  private readonly maxNetworkEvents: number;

  constructor() {
    const config = getSandboxConfig();
    this.maxEvents = config.maxEvents;
    this.maxEventSize = config.maxEventSize;
    this.maxLogLength = config.maxLogLength;
    this.maxNetworkEvents = config.maxNetworkEvents;
  }

  append(input: {
    type: RuntimeEventType;
    level: RuntimeEventLevel;
    source: string;
    message: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): RuntimeEvent | null {
    const message = truncate(input.message, this.maxLogLength);
    const serialized = JSON.stringify({
      type: input.type,
      level: input.level,
      source: input.source,
      message,
      metadata: input.metadata ?? {},
    });
    if (serialized.length > this.maxEventSize) {
      this.suppressedEvents += 1;
      return null;
    }

    const event: RuntimeEvent = {
      id: generateEventId(),
      timestamp: Date.now(),
      type: input.type,
      level: input.level,
      source: truncate(input.source, 128),
      message,
      metadata: input.metadata,
    };

    if (this.events.length >= this.maxEvents) {
      this.suppressedEvents += 1;
      return null;
    }
    this.events.push(event);
    return event;
  }

  appendNetwork(entry: Omit<NetworkEntry, "id" | "timestamp">): void {
    if (this.networkEntries.length >= this.maxNetworkEvents) {
      return;
    }
    this.networkEntries.push({
      id: generateEventId(),
      timestamp: Date.now(),
      ...entry,
    });
  }

  getAll(): RuntimeEvent[] {
    return [...this.events];
  }

  getNetwork(): NetworkEntry[] {
    return [...this.networkEntries];
  }

  getSuppressedCount(): number {
    return this.suppressedEvents;
  }

  clear(): void {
    this.events.length = 0;
    this.networkEntries.length = 0;
    this.suppressedEvents = 0;
  }

  get size(): number {
    return this.events.length;
  }
}
