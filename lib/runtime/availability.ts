import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "@/lib/config/env";
import { isRuntimeEnabled } from "./config";

const execFileAsync = promisify(execFile);

export interface SandboxProbeResult {
  available: boolean;
  /** Stable, non-sensitive reason code when unavailable. */
  reason?: "disabled" | "docker_missing" | "docker_unreachable" | "image_missing";
}

let cache: { at: number; result: SandboxProbeResult } | null = null;
const CACHE_MS = 10_000;

/**
 * Checks whether real Docker execution is possible: the Docker CLI exists,
 * the daemon answers, and the pinned sandbox image is present. Results are
 * cached briefly. Never returns versions, hostnames or socket paths.
 */
export async function probeSandboxEnvironment(force = false): Promise<SandboxProbeResult> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  const result = await probe();
  cache = { at: Date.now(), result };
  return result;
}

async function probe(): Promise<SandboxProbeResult> {
  if (!isRuntimeEnabled() || getConfig().sandbox.disabled) return { available: false, reason: "disabled" };
  const dockerBin = process.env.DOCKER_BIN || "docker";
  try {
    await execFileAsync(dockerBin, ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000, maxBuffer: 64 * 1024 });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { available: false, reason: code === "ENOENT" ? "docker_missing" : "docker_unreachable" };
  }
  try {
    await execFileAsync(dockerBin, ["image", "inspect", getConfig().sandbox.image, "--format", "{{.Id}}"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
  } catch {
    return { available: false, reason: "image_missing" };
  }
  return { available: true };
}

export function resetSandboxProbeCache(): void {
  cache = null;
}
