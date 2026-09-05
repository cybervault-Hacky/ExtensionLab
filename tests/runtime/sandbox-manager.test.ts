import { describe, expect, it } from "vitest";
import { SandboxManager } from "@/lib/runtime/sandbox-manager";
import { getSandboxConfig, type SandboxConfig } from "@/lib/runtime/config";
import type { ContainerHandle, SandboxDriver } from "@/lib/runtime/driver";
import type { ControlClient } from "@/lib/runtime/control-client";
import { SandboxRuntimeError } from "@/lib/runtime/errors";
import type { RuntimeEvent } from "@/types/runtime";

class FakeDriver implements SandboxDriver {
  readonly name = "fake";
  availableCalled = 0;
  removed: string[] = [];

  async available(): Promise<boolean> {
    this.availableCalled += 1;
    return true;
  }

  async create(_sandboxId: string, _sourcePath: string, runnerToken: string): Promise<ContainerHandle> {
    const control = makeFakeControlClient();
    return {
      containerId: `fake-${_sandboxId}`,
      controlPort: 0,
      controlClient: control as unknown as ControlClient,
      runnerToken,
    };
  }

  async remove(handle: ContainerHandle): Promise<void> {
    this.removed.push(handle.containerId);
  }

  async isRunning(): Promise<boolean> {
    return true;
  }
}

function makeFakeControlClient(): Omit<
  ControlClient,
  "baseUrl" | "health" | "command" | "streamEvents" | "screenshot"
> & ControlClient {
  const fake = {
    async command(): Promise<{ ok: boolean; status: string; message?: string }> {
      return { ok: true, status: "running" };
    },
    async streamEvents(
      _token: string,
      onEvent: (event: RuntimeEvent) => void,
    ): Promise<() => void> {
      onEvent({
        id: "evt-1",
        timestamp: Date.now(),
        type: "extension",
        level: "info",
        source: "extension",
        message: "Extension loaded.",
      });
      return () => undefined;
    },
    async screenshot(): Promise<Uint8Array | null> {
      return null;
    },
    async health(): Promise<boolean> {
      return true;
    },
  };
  return fake as unknown as ControlClient;
}

function testConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  const base = getSandboxConfig();
  return {
    ...base,
    maxRuntimeMs: 500,
    orphanCheckIntervalMs: 60_000,
    cleanupGraceMs: 2_000,
    maxConcurrentSandboxes: 2,
    maxSandboxesPerWindow: 10,
    ...overrides,
  };
}

describe("SandboxManager", () => {
  it("creates and starts a sandbox through the driver", async () => {
    const driver = new FakeDriver();
    const manager = new SandboxManager(driver, testConfig());
    const created = await manager.create({
      sourcePath: "/tmp/does-not-exist",
      clientIp: "127.0.0.1",
    });
    expect(created.status).toBe("preparing");

    const started = await manager.start(created.sandboxId, created.sessionToken);
    expect(started.status).toBe("running");
    expect(driver.availableCalled).toBeGreaterThan(0);
    manager.dispose();
  });

  it("stops and destroys the sandbox container", async () => {
    const driver = new FakeDriver();
    const manager = new SandboxManager(driver, testConfig());
    const created = await manager.create({
      sourcePath: "/tmp/does-not-exist-2",
      clientIp: "127.0.0.1",
    });
    await manager.start(created.sandboxId, created.sessionToken);
    await manager.stop(created.sandboxId, created.sessionToken);
    const info = await manager.getInfo(created.sandboxId, created.sessionToken);
    expect(info.status).toBe("destroyed");
    expect(driver.removed).toHaveLength(1);
    manager.dispose();
  });

  it("enforces concurrent sandbox limits", async () => {
    const manager = new SandboxManager(
      new FakeDriver(),
      testConfig({ maxConcurrentSandboxes: 1 }),
    );
    const first = await manager.create({ sourcePath: "/tmp/a", clientIp: "ip-a" });
    await expect(
      manager.create({ sourcePath: "/tmp/b", clientIp: "ip-a" }),
    ).rejects.toMatchObject({ code: "capacity_reached" });
    await manager.stop(first.sandboxId, first.sessionToken);
    manager.dispose();
  });

  it("enforces per-IP rate limits", async () => {
    const manager = new SandboxManager(
      new FakeDriver(),
      testConfig({ maxConcurrentSandboxes: 10, maxSandboxesPerWindow: 2 }),
    );
    await manager.create({ sourcePath: "/tmp/a", clientIp: "ip-rate" });
    await manager.create({ sourcePath: "/tmp/b", clientIp: "ip-rate" });
    await expect(
      manager.create({ sourcePath: "/tmp/c", clientIp: "ip-rate" }),
    ).rejects.toBeInstanceOf(SandboxRuntimeError);
    manager.dispose();
  });

  it("cleans up a timed-out sandbox automatically", async () => {
    const driver = new FakeDriver();
    const manager = new SandboxManager(
      driver,
      testConfig({ maxRuntimeMs: 20, cleanupGraceMs: 3000 }),
    );
    const created = await manager.create({ sourcePath: "/tmp/timeout", clientIp: "ip-timeout" });
    await manager.start(created.sandboxId, created.sessionToken);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const info = await manager.getInfo(created.sandboxId, created.sessionToken);
    expect(info.status).toBe("timeout");
    expect(driver.removed).toHaveLength(1);
    manager.dispose();
  });
});
