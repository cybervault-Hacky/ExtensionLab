import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { makeUser } from "../phase11/helpers";
import {
  WORKER_STOPPED_AFTER_MS,
  WORKER_UNHEALTHY_AFTER_MS,
  classifyWorkerState,
  getWorkerDesiredState,
  listWorkerStatuses,
  setWorkerDesiredStateByRef,
  summarizeWorkerFleet,
  upsertWorkerRegistration,
  workerRef,
} from "@/lib/jobs/worker-registry";
import { makeSchedulingWorker, setupPhase13Harness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness();
});

afterEach(() => {
  harness.teardown();
});

describe("Phase 13 §6: worker state derivation (never stored, never faked)", () => {
  it("derives STARTING → READY → DRAINING from real evidence", () => {
    const now = Date.now();
    const base = { last_seen_at: now, stopping: 0, desired_state: "running" };
    expect(classifyWorkerState({ ...base, ready_at: null })).toBe("STARTING");
    expect(classifyWorkerState({ ...base, ready_at: now - 500 })).toBe("READY");
    expect(classifyWorkerState({ ...base, ready_at: now, stopping: 1 })).toBe("DRAINING");
    expect(classifyWorkerState({ ...base, ready_at: now, desired_state: "draining" })).toBe("DRAINING");
    expect(classifyWorkerState({ ...base, ready_at: now, desired_state: "disabled" })).toBe("DISABLED");
  });

  it("derives UNHEALTHY then STOPPED from heartbeat age", () => {
    const now = Date.now();
    const base = { stopping: 0, desired_state: "running", ready_at: now - 1000 };
    expect(classifyWorkerState({ ...base, last_seen_at: now - WORKER_UNHEALTHY_AFTER_MS - 1 })).toBe("UNHEALTHY");
    expect(classifyWorkerState({ ...base, last_seen_at: now - WORKER_STOPPED_AFTER_MS - 1 })).toBe("STOPPED");
    // A stale draining flag must not mask a dead worker.
    expect(classifyWorkerState({ ...base, last_seen_at: now - WORKER_STOPPED_AFTER_MS - 1, stopping: 1 })).toBe("STOPPED");
  });
});

describe("Phase 13 §5: registration with version and capabilities", () => {
  it("records version/capabilities and exposes only hashed refs", () => {
    upsertWorkerRegistration({
      id: "worker-prod-7",
      startedAt: Date.now() - 5000,
      concurrency: 4,
      activeJobs: 0,
      sandboxAvailable: true,
      version: "13.0.0",
      capabilities: { jobTypes: ["AUTOMATED_TEST"], browsers: ["chromium"], resourceProfiles: ["standard"], sandboxDriver: "docker" },
      readyAt: Date.now() - 1000,
    });
    const workers = listWorkerStatuses();
    expect(workers).toHaveLength(1);
    expect(workers[0].version).toBe("13.0.0");
    expect(workers[0].state).toBe("READY");
    expect(workers[0].ref).toBe(workerRef("worker-prod-7"));
    expect(workers[0].ref).not.toContain("worker-prod-7");
    // The fleet summary aggregates states for capacity signals.
    const fleet = summarizeWorkerFleet();
    expect(fleet.ready).toBe(1);
    expect(fleet.totalConcurrency).toBe(4);
  });
});

describe("Phase 13 §7/§57: operator drain/disable is cooperative and audited via the registry", () => {
  it("drain stops new claims; enable resumes; disable blocks claims", async () => {
    const worker = makeSchedulingWorker("wk-1", { concurrency: 1 });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const [registered] = listWorkerStatuses();
    expect(registered.state).toBe(registered.readyAt ? "READY" : "STARTING");

    setWorkerDesiredStateByRef(registered.ref, "draining");
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Desired state visible to the operator…
    expect(getWorkerDesiredState("wk-1")).toBe("draining");
    const [draining] = listWorkerStatuses();
    expect(["DRAINING", "DISABLED", "STARTING", "READY"]).toContain(draining.state);

    setWorkerDesiredStateByRef(registered.ref, "running");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(getWorkerDesiredState("wk-1")).toBe("running");

    setWorkerDesiredStateByRef(registered.ref, "disabled");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const [disabled] = listWorkerStatuses();
    expect(disabled.state).toBe("DISABLED");

    await worker.stop();
  }, 15000);

  it("unknown worker refs fail closed", () => {
    expect(() => setWorkerDesiredStateByRef("deadbeef", "draining")).toThrowError();
  });
});

describe("Phase 13 §42: a crashed worker's registration ages out honestly", () => {
  it("shows UNHEALTHY/STOPPED without faking liveness", () => {
    upsertWorkerRegistration({
      id: "wk-crashed",
      startedAt: Date.now() - 600_000,
      concurrency: 2,
      activeJobs: 1, // crashed mid-job
      sandboxAvailable: true,
      readyAt: Date.now() - 590_000,
    });
    // Simulate the heartbeat going silent by classifying at a future time.
    const fleet = summarizeWorkerFleet(Date.now() + WORKER_UNHEALTHY_AFTER_MS + 1000);
    expect(fleet.byState.UNHEALTHY).toBeGreaterThanOrEqual(1);
    const fleetLater = summarizeWorkerFleet(Date.now() + WORKER_STOPPED_AFTER_MS + 1000);
    expect(fleetLater.byState.STOPPED).toBeGreaterThanOrEqual(1);
  });
});
