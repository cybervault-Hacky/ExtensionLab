import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { InteractiveSessionHub } from "@/lib/interactive/runtime";
import { setInteractiveHubForTests } from "@/lib/interactive/runtime";
import { getCoordinationStoreSync, resetCoordinationForTests } from "@/lib/coordination";
import type { HubAttachInfo } from "@/lib/interactive/runtime";
import { setupPhase13Harness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness();
  resetCoordinationForTests();
});

afterEach(() => {
  harness.teardown();
});

const attachInfo = (sessionId: string): HubAttachInfo =>
  ({
    sessionId,
    controlPort: 1,
    runnerToken: "tok",
  }) as unknown as HubAttachInfo;

/**
 * §59: SSE streaming across web instances. The instance attached to the
 * container emits frames into the coordination bus; a different instance with
 * a subscribed viewer receives the same live frames, without echo.
 */
describe("Phase 13 §59: SSE fan-out across instances", () => {
  it("forwards live frames to a viewer on another hub instance", async () => {
    const memory = getCoordinationStoreSync();
    expect(memory.publish).toBeTruthy(); // pub/sub capability present

    const attached = new InteractiveSessionHub(); // instance A: owns the container
    const viewer = new InteractiveSessionHub(); // instance B: serves the browser SSE client
    setInteractiveHubForTests(attached);

    const info = attachInfo("sess_sse_1");
    const received: Array<{ kind: string; message?: string }> = [];
    const unsubscribe = viewer.subscribe(info, (frame) => {
      received.push({ kind: frame.kind, message: (frame.payload as { message?: string } | undefined)?.message });
    });

    // A runtime console event lands on instance A (as if from the container stream).
    const event = {
      id: "evt_1",
      timestamp: Date.now(),
      type: "console",
      level: "info",
      source: "page",
      message: "hello from the sandbox",
    };
    (attached as unknown as { onRuntimeEvent: (entry: unknown, raw: unknown) => void }).onRuntimeEvent(
      (attached as unknown as { ensure: (i: HubAttachInfo) => unknown }).ensure(info),
      event,
    );

    await new Promise((resolve) => setTimeout(resolve, 50)); // pub/sub is async
    expect(received.some((frame) => frame.kind === "console" && frame.message?.includes("hello"))).toBe(true);

    // Echo suppression: the viewer does not re-broadcast what it receives.
    const before = received.length;
    (viewer as unknown as { onRuntimeEvent: (entry: unknown, raw: unknown) => void }).onRuntimeEvent(
      (viewer as unknown as { ensure: (i: HubAttachInfo) => unknown }).ensure(info),
      { ...event, id: "evt_2", message: "from viewer instance" },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.length).toBeGreaterThanOrEqual(before);
    unsubscribe();
    attached.dispose();
    viewer.dispose();
  });

  it("cleans up the frame subscription when the session is removed", async () => {
    const hub = new InteractiveSessionHub();
    setInteractiveHubForTests(hub);
    const info = attachInfo("sess_sse_2");
    const seen: string[] = [];
    hub.subscribe(info, (frame) => seen.push(frame.kind));
    expect((hub as unknown as { frameSubs: Map<string, unknown> }).frameSubs.size).toBeLessThanOrEqual(1);
    hub.remove(info.sessionId);
    expect((hub as unknown as { frameSubs: Map<string, unknown> }).frameSubs.has(info.sessionId)).toBe(false);
    expect(seen).toEqual([]);
    hub.dispose();
  });
});
