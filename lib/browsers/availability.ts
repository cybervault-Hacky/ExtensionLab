import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBrowserRegistryConfig } from "./registry";
import { isBrowserId, type BrowserId } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Per-browser runtime availability.
 *
 * A browser execution is only queued when its pinned image is present, so the
 * platform never enqueues doomed executions it can detect up front. Results
 * are cached briefly; details beyond a boolean + stable reason code are never
 * exposed to clients.
 */

export interface BrowserRuntimeHealth {
  browserId: BrowserId;
  available: boolean;
  reason?: "disabled" | "image_missing" | "docker_unavailable" | "unknown";
}

export type BrowserHealthMap = Readonly<Record<BrowserId, BrowserRuntimeHealth>>;

const CACHE_MS = 10_000;
let cache: { at: number; map: BrowserHealthMap } | null = null;
/** Test-only override so unit tests can exercise scheduling without Docker. */
let testOverride: BrowserHealthMap | null = null;

export function setBrowserHealthForTests(map: BrowserHealthMap | null): void {
  testOverride = map;
  cache = null;
}

async function dockerInspectImage(image: string): Promise<boolean> {
  const dockerBin = process.env.DOCKER_BIN || "docker";
  try {
    await execFileAsync(dockerBin, ["image", "inspect", image, "--format", "{{.Id}}"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") throw new Error("docker_missing");
    return false;
  }
}

async function probeBrowser(browserId: BrowserId): Promise<BrowserRuntimeHealth> {
  const config = getBrowserRegistryConfig();
  if (!config.enabled[browserId]) return { browserId, available: false, reason: "disabled" };
  let dockerReachable = true;
  try {
    const dockerBin = process.env.DOCKER_BIN || "docker";
    await execFileAsync(dockerBin, ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
  } catch {
    dockerReachable = false;
  }
  if (!dockerReachable) {
    return { browserId, available: false, reason: "docker_unavailable" };
  }
  const present = await dockerInspectImage(config.images[browserId]);
  return present
    ? { browserId, available: true }
    : { browserId, available: false, reason: "image_missing" };
}

export async function getBrowserRuntimesHealth(force = false): Promise<BrowserHealthMap> {
  if (testOverride) return testOverride;
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.map;
  const entries = await Promise.all(
    (["chromium", "edge", "firefox"] as BrowserId[]).map((id) => probeBrowser(id)),
  );
  const map = Object.fromEntries(entries.map((entry) => [entry.browserId, entry])) as BrowserHealthMap;
  cache = { at: Date.now(), map };
  return map;
}

export async function getBrowserRuntimeHealth(browserId: BrowserId, force = false): Promise<BrowserRuntimeHealth> {
  const map = await getBrowserRuntimesHealth(force);
  return map[browserId];
}

export function resetBrowserHealthCache(): void {
  cache = null;
}

/**
 * Internal worker health metadata (never exposed publicly as-is): browser,
 * configured version, engine and availability per runtime.
 */
export function internalBrowserHealth(profile: { browserId: BrowserId; version: string; engine: string; enabled: boolean }, health: BrowserRuntimeHealth) {
  return {
    browser: profile.browserId,
    version: profile.version,
    engine: profile.engine,
    available: health.available,
    reason: health.reason ?? null,
    image: undefined,
  };
}

export { isBrowserId };
