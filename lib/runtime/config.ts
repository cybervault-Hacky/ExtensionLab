import "server-only";

/**
 * Central Phase 3 configuration.
 *
 * All sandbox limits live here rather than being scattered through the code.
 * Values may be overridden by documented environment variables. Real secrets
 * must never be passed to the sandbox.
 */

export interface SandboxConfig {
  image: string;
  maxRuntimeMs: number;
  defaultMemoryLimit: string;
  defaultCpuLimit: string;
  maxConcurrentSandboxes: number;
  maxSandboxesPerWindow: number;
  rateLimitWindowMs: number;
  networkMode: "restricted" | "none";
  allowedSchemes: Array<"https:" | "http:">;
  allowHttp: boolean;
  maxUrlLength: number;
  maxEvents: number;
  maxEventSize: number;
  maxLogLength: number;
  maxNetworkEvents: number;
  maxNetworkUrlLength: number;
  runnerControlPort: number;
  runnerHealthTimeoutMs: number;
  containerStartTimeoutMs: number;
  cleanupGraceMs: number;
  orphanCheckIntervalMs: number;
  tempRoot: string;
  sandboxTtlMs: number;
}

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  if (!value || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const boolFromEnv = (
  value: string | undefined,
  fallback: boolean,
): boolean => {
  if (!value || value.trim() === "") return fallback;
  return value.toLowerCase() === "true" || value === "1";
};

export function getSandboxConfig(): SandboxConfig {
  const networkMode = process.env.SANDBOX_NETWORK_MODE?.toLowerCase();
  return {
    image: process.env.SANDBOX_IMAGE || "extensionlab-sandbox:local",
    maxRuntimeMs: numberFromEnv(process.env.SANDBOX_MAX_RUNTIME, 120) * 1000,
    defaultMemoryLimit: process.env.SANDBOX_MEMORY_LIMIT || "768m",
    defaultCpuLimit: process.env.SANDBOX_CPU_LIMIT || "0.5",
    maxConcurrentSandboxes: numberFromEnv(
      process.env.SANDBOX_MAX_CONCURRENT,
      2,
    ),
    maxSandboxesPerWindow: numberFromEnv(
      process.env.SANDBOX_MAX_PER_WINDOW,
      4,
    ),
    rateLimitWindowMs: numberFromEnv(
      process.env.SANDBOX_RATE_LIMIT_WINDOW_MS,
      60 * 1000,
    ),
    networkMode: networkMode === "none" ? "none" : "restricted",
    allowedSchemes: ["https:", "http:"],
    allowHttp: boolFromEnv(process.env.SANDBOX_ALLOW_HTTP, false),
    maxUrlLength: numberFromEnv(process.env.SANDBOX_MAX_URL_LENGTH, 2048),
    maxEvents: numberFromEnv(process.env.SANDBOX_MAX_EVENTS, 500),
    maxEventSize: numberFromEnv(process.env.SANDBOX_MAX_EVENT_SIZE, 8 * 1024),
    maxLogLength: numberFromEnv(process.env.SANDBOX_MAX_LOG_LENGTH, 2000),
    maxNetworkEvents: numberFromEnv(process.env.SANDBOX_MAX_NETWORK_EVENTS, 200),
    maxNetworkUrlLength: numberFromEnv(
      process.env.SANDBOX_MAX_NETWORK_URL_LENGTH,
      512,
    ),
    runnerControlPort: numberFromEnv(process.env.SANDBOX_RUNNER_CONTROL_PORT, 9333),
    runnerHealthTimeoutMs: numberFromEnv(
      process.env.SANDBOX_RUNNER_HEALTH_TIMEOUT_MS,
      30000,
    ),
    containerStartTimeoutMs: numberFromEnv(
      process.env.SANDBOX_CONTAINER_START_TIMEOUT_MS,
      30000,
    ),
    cleanupGraceMs: numberFromEnv(
      process.env.SANDBOX_CLEANUP_GRACE_MS,
      5000,
    ),
    orphanCheckIntervalMs: numberFromEnv(
      process.env.SANDBOX_ORPHAN_CHECK_MS,
      30000,
    ),
    tempRoot: process.env.SANDBOX_TEMP_ROOT || "/tmp/extensionlab-runtime",
    sandboxTtlMs: numberFromEnv(process.env.SANDBOX_TTL_MS, 30 * 60 * 1000),
  };
}

export function isRuntimeEnabled(): boolean {
  return process.env.SANDBOX_DISABLED !== "true";
}
