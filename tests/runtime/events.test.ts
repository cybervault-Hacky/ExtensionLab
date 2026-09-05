import { describe, expect, it } from "vitest";
import { RuntimeEventBuffer } from "@/lib/runtime/events";

describe("RuntimeEventBuffer", () => {
  it("suppresses events after the configured limit is reached", () => {
    process.env.SANDBOX_MAX_EVENTS = "3";
    process.env.SANDBOX_MAX_LOG_LENGTH = "100";
    process.env.SANDBOX_MAX_EVENT_SIZE = "8192";
    const buffer = new RuntimeEventBuffer();
    const first = buffer.append({ type: "console", level: "log", source: "page", message: "one" });
    const second = buffer.append({ type: "console", level: "log", source: "page", message: "two" });
    const third = buffer.append({ type: "console", level: "log", source: "page", message: "three" });
    const fourth = buffer.append({ type: "console", level: "error", source: "page", message: "four" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect(fourth).toBeNull();
    expect(buffer.getAll()).toHaveLength(3);
    expect(buffer.getSuppressedCount()).toBe(1);
  });

  it("truncates long messages", () => {
    process.env.SANDBOX_MAX_LOG_LENGTH = "20";
    const buffer = new RuntimeEventBuffer();
    const event = buffer.append({ type: "console", level: "log", source: "page", message: "a".repeat(100) });
    expect(event?.message.length).toBeLessThanOrEqual(20);
  });

  it("limits network entries", () => {
    process.env.SANDBOX_MAX_NETWORK_EVENTS = "2";
    const buffer = new RuntimeEventBuffer();
    buffer.appendNetwork({ method: "GET", url: "a", status: 200, resourceType: "doc", duration: 1 });
    buffer.appendNetwork({ method: "GET", url: "b", status: 200, resourceType: "doc", duration: 1 });
    buffer.appendNetwork({ method: "GET", url: "c", status: 200, resourceType: "doc", duration: 1 });
    expect(buffer.getNetwork()).toHaveLength(2);
  });
});
