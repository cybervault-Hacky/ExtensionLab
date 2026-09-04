import "server-only";
import { SandboxManager } from "./sandbox-manager";
import { createDockerDriver } from "./docker-driver";

let instance: SandboxManager | null = null;

/**
 * Process-local singleton.
 *
 * For a multi-replica deployment this must be replaced with a shared store
 * (e.g. Redis + a durable queue). Phase 3 targets a single API process.
 */
export function getSandboxManager(): SandboxManager {
  if (!instance) {
    instance = new SandboxManager(createDockerDriver());
  }
  return instance;
}
