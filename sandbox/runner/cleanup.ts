import { rm } from "node:fs/promises";

export async function cleanupRuntimeDirectories(): Promise<void> {
  await Promise.allSettled([
    rm("/tmp/extension", { recursive: true, force: true }),
    rm("/tmp/browser-profile", { recursive: true, force: true }),
  ]);
}
