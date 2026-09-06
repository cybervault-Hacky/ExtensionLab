import "server-only";
import { getSandboxConfig } from "./config";
import { getFreePort } from "./ports";
import type { RuntimeEvent, SandboxAction } from "@/types/runtime";
import { ControlClient } from "./control-client";

export interface ContainerHandle {
  containerId: string;
  controlPort: number;
  controlClient: ControlClient;
  runnerToken: string;
  /** Browser runtime the container was created for (Phase 9; defaults to chromium). */
  browserId?: string;
  /** Phase 13 §18: exact pinned image reference used for this execution. */
  imageRef?: string;
  /** Phase 13 §18: immutable image content digest when resolvable. */
  imageDigest?: string | null;
}

export interface CreateSandboxOptions {
  /**
   * Phase 9 browser runtime. The driver picks the pinned per-browser image and
   * tells the in-container runner which browser adapter to start. Unknown ids
   * must never reach this layer (validated by the browser registry).
   */
  browserId?: string;
  /**
   * Phase 13 §12: server-resolved resource profile (plan entitlement only;
   * never client-supplied). Tightens memory/CPU/PID/shm within deployment caps.
   */
  resourceProfile?: "standard" | "heavy";
  /**
   * Phase 13 §16: ownership labels for internal reconciliation. `sessionId` is
   * the interactive session id when known; `ownerKind` distinguishes
   * interactive sessions from automated-test sandboxes (managed in-process).
   */
  ownerKind?: "interactive" | "test";
  sessionId?: string;
}

/** A container owned by this deployment (label-scoped; Phase 13 reconciliation). */
export interface OwnedContainerInfo {
  containerId: string;
  name: string;
  labels: Record<string, string>;
  /** Container creation time (ms epoch) when the driver reports it. */
  createdAt?: number;
}

export interface SandboxDriver {
  readonly name: string;
  available(): Promise<boolean>;
  create(sandboxId: string, sourcePath: string, runnerToken: string, options?: CreateSandboxOptions): Promise<ContainerHandle>;
  remove(handle: ContainerHandle): Promise<void>;
  isRunning(handle: ContainerHandle): Promise<boolean>;
  /**
   * Phase 13 §15/§16: list containers carrying ExtensionLab-owned labels.
   * Optional so test drivers stay small; reconciliation skips drivers without it.
   */
  listOwnedContainers?(): Promise<OwnedContainerInfo[]>;
}

export async function newContainerHandle(runnerToken = ""): Promise<ContainerHandle> {
  const controlPort = await getFreePort();
  return {
    containerId: "",
    controlPort,
    controlClient: new ControlClient(controlPort),
    runnerToken,
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
