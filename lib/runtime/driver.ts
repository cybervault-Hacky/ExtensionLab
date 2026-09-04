import "server-only";
import { getSandboxConfig } from "./config";
import { getFreePort } from "./ports";
import type { RuntimeEvent, SandboxAction } from "@/types/runtime";
import { ControlClient } from "./control-client";

export interface ContainerHandle {
  containerId: string;
  controlPort: number;
  controlClient: ControlClient;
}

export interface SandboxDriver {
  readonly name: string;
  available(): Promise<boolean>;
  create(sandboxId: string, sourcePath: string): Promise<ContainerHandle>;
  remove(handle: ContainerHandle): Promise<void>;
  isRunning(handle: ContainerHandle): Promise<boolean>;
}

export async function newContainerHandle(): Promise<ContainerHandle> {
  const controlPort = await getFreePort();
  return {
    containerId: "",
    controlPort,
    controlClient: new ControlClient(controlPort),
  };
}

export async function waitForControl(
  handle: ContainerHandle,
  timeoutMs = getSandboxConfig().runnerHealthTimeoutMs,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await handle.controlClient.health(2000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

export type { RuntimeEvent, SandboxAction };
