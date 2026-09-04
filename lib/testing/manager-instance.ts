import "server-only";
import { TestRunManager } from "./test-runner";
import { getSandboxManager } from "@/lib/runtime/sandbox-manager-instance";

let instance: TestRunManager | null = null;

export function getTestRunManager(): TestRunManager {
  if (!instance) {
    instance = new TestRunManager(getSandboxManager());
  }
  return instance;
}
