import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSandboxConfig } from "./config";
import { getBrowserRegistryConfig } from "@/lib/browsers/registry";
import { getConfig } from "@/lib/config/env";
import { isBrowserId, type BrowserId } from "@/lib/browsers/types";
import { getFreePort } from "./ports";
import { ControlClient } from "./control-client";
import { waitForControl, type ContainerHandle, type CreateSandboxOptions, type SandboxDriver } from "./driver";
import { RESOURCE_PROFILES, type ResourceProfile, type ResourceProfileId } from "./profiles";

const execFileAsync = promisify(execFile);

/**
 * Docker-backed sandbox driver.
 *
 * The host process never runs extension code directly. It only manages a
 * fresh, non-privileged, read-only-root container with a loopback-only control
 * port. The extension source is copied into the container's disposable tmpfs.
 *
 * Phase 9: each browser runtime has its own pinned image; the security profile
 * (cap-drop ALL, no-new-privileges, read-only root, tmpfs, CPU/memory/PID
 * limits, no privileged, no host network, no docker socket) is identical for
 * every browser — Firefox and Edge receive exactly the same hardening as
 * Chromium.
 *
 * Phase 13: `buildSandboxCreateArgs` is a pure function so the hardening
 * baseline is unit-testable; every container carries ExtensionLab-owned
 * labels (environment/session/worker/browser) used ONLY for internal
 * reconciliation; resource profiles tighten limits per plan entitlement; and
 * the exact image reference+digest is captured for reproducibility.
 */

export interface SandboxLabels {
  environment: string;
  session: string;
  worker?: string;
  browser: string;
  /** "interactive" (session-managed) or "test" (sandbox-manager-managed). */
  owner?: string;
}

export interface BuildCreateArgsInput {
  name: string;
  image: string;
  controlPort: number;
  runnerToken: string;
  sandboxId: string;
  browserId: string;
  network: "bridge" | "none";
  runnerControlPort: number;
  labels: SandboxLabels;
  profile?: ResourceProfile;
  /** Deployment-level defaults (memory/cpu) when no profile overrides them. */
  defaultMemoryLimit: string;
  defaultCpuLimit: string;
}

/**
 * The complete `docker create` argument list. Pure: exported so tests can
 * assert the hardening contract (§13/§71) without Docker.
 */
export function buildSandboxCreateArgs(input: BuildCreateArgsInput): string[] {
  const profile = input.profile;
  const memoryLimit = profile?.memoryLimit ?? input.defaultMemoryLimit;
  const cpuLimit = profile?.cpuLimit ?? input.defaultCpuLimit;
  const pidsLimit = profile?.pidsLimit ?? 200;
  const shmSize = profile?.shmSize ?? "256m";
  const labels: Array<[string, string]> = [
    ["extensionlab.sandbox", "1"],
    ["extensionlab.environment", input.labels.environment],
    ["extensionlab.session", input.labels.session],
    ["extensionlab.browser", input.labels.browser],
  ];
  if (input.labels.worker) labels.push(["extensionlab.worker", input.labels.worker]);
  if (input.labels.owner) labels.push(["extensionlab.owner", input.labels.owner]);

  const args = ["create", "--name", input.name];
  for (const [key, value] of labels) args.push("--label", `${key}=${value}`);
  args.push(
    "--network",
    input.network,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "node",
    "--init",
    "--pids-limit",
    String(pidsLimit),
    "--shm-size",
    shmSize,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--tmpfs",
    "/home/node/.cache:rw,size=256m",
    "-m",
    memoryLimit,
    "--cpus",
    cpuLimit,
    "-p",
    `127.0.0.1:${input.controlPort}:${input.runnerControlPort}`,
    "-e",
    `RUNNER_TOKEN=${input.runnerToken}`,
    "-e",
    "SANDBOX_ID=" + input.sandboxId,
    "-e",
    `EXTENSIONLAB_BROWSER=${input.browserId}`,
    input.image,
  );
  return args;
}

export class DockerSandboxDriver implements SandboxDriver {
  readonly name = "docker";

  private readonly dockerBin = process.env.DOCKER_BIN || "docker";
  private readonly image: string;

  constructor(image = getSandboxConfig().image) {
    this.image = image;
  }

  async available(): Promise<boolean> {
    try {
      await this.run(["info", "--format", "{{.ServerVersion}}"]);
      return true;
    } catch {
      return false;
    }
  }

  async create(
    sandboxId: string,
    sourcePath: string,
    runnerToken: string,
    options?: CreateSandboxOptions,
  ): Promise<ContainerHandle> {
    const config = getSandboxConfig();
    const browserId: BrowserId = isBrowserId(options?.browserId) ? options!.browserId! : "chromium";
    const image = this.imageForBrowser(browserId);
    const controlPort = await getFreePort();
    const name = `extensionlab-${sandboxId}`;
    const network = config.networkMode === "none" ? "none" : "bridge";
    const token = runnerToken;
    const profileId: ResourceProfileId | undefined = options?.resourceProfile;
    const profile = profileId ? RESOURCE_PROFILES[profileId] : undefined;

    const args = buildSandboxCreateArgs({
      name,
      image,
      controlPort,
      runnerToken: token,
      sandboxId,
      browserId,
      network,
      runnerControlPort: config.runnerControlPort,
      labels: {
        environment: getConfig().appEnv,
        session: options?.sessionId ?? sandboxId,
        worker: process.env.WORKER_ID || configJobsWorkerId(),
        browser: browserId,
        owner: options?.ownerKind ?? "test",
      },
      profile,
      defaultMemoryLimit: config.defaultMemoryLimit,
      defaultCpuLimit: config.defaultCpuLimit,
    });

    const created = await this.run(args);
    const containerId = created.stdout.trim();
    if (!containerId) {
      throw new Error("Docker returned an empty container id.");
    }

    // Copy extension source before the runner is asked to start.
    await this.run(["cp", `${sourcePath}/.`, `${containerId}:/tmp/extension`]);
    await this.run(["start", containerId]);

    // Phase 13 §18: record the exact image reference + content digest with the
    // execution for reproducibility (best-effort; never blocks the session).
    const imageIdentity = await this.imageIdentity(image).catch(() => null);

    const handle: ContainerHandle = {
      containerId,
      controlPort,
      controlClient: new ControlClient(controlPort),
      runnerToken,
      browserId,
      imageRef: imageIdentity?.ref ?? image,
      imageDigest: imageIdentity?.digest ?? null,
    };
    const ready = await waitForControl(handle, config.runnerHealthTimeoutMs);
    if (!ready) {
      await this.remove(handle);
      throw new Error("Sandbox runner did not become available.");
    }

    return handle;
  }

  async remove(handle: ContainerHandle): Promise<void> {
    if (!handle.containerId) return;
    try {
      await this.run(["rm", "-f", handle.containerId]);
    } catch {
      // The container may already be gone. Cleanup is best-effort.
    }
  }

  async isRunning(handle: ContainerHandle): Promise<boolean> {
    try {
      const result = await this.run([
        "inspect",
        "-f",
        "{{.State.Running}}",
        handle.containerId,
      ]);
      return result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Phase 13 §15/§16: list ExtensionLab-OWNED containers (label-scoped).
   * Reconciliation only ever considers containers carrying our labels, and
   * callers must additionally verify the environment label matches before
   * removing anything — a foreign deployment's containers are untouchable.
   */
  async listOwnedContainers(): Promise<Array<{ containerId: string; name: string; labels: Record<string, string>; createdAt?: number }>> {
    const output = await this.run([
      "ps",
      "-a",
      "--filter",
      "label=extensionlab.sandbox=1",
      "--format",
      "{{.ID}}\t{{.Names}}\t{{.Label \"extensionlab.environment\"}}\t{{.Label \"extensionlab.session\"}}\t{{.Label \"extensionlab.browser\"}}",
    ]);
    const lines = output.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.map((line) => {
      const [containerId, name, environment, session, browser] = line.split("\t");
      return {
        containerId,
        name: name ?? "",
        labels: {
          "extensionlab.environment": environment ?? "",
          "extensionlab.session": session ?? "",
          "extensionlab.browser": browser ?? "",
        },
      };
    });
  }

  /** Exact image reference and digest (§17/§18): immutable identity. */
  async imageIdentity(image: string): Promise<{ ref: string; digest: string | null }> {
    const result = await this.run(["image", "inspect", image, "--format", "{{index .RepoDigests 0}}"]);
    const digestEntry = result.stdout.trim();
    const digest = digestEntry.startsWith("sha256:") ? digestEntry : (digestEntry.split("@")[1] ?? null);
    return { ref: image, digest: digest && digest.startsWith("sha256:") ? digest : null };
  }

  /** Server-internal: pinned image for a browser runtime. */
  private imageForBrowser(browserId: BrowserId): string {
    if (browserId === "chromium" && !process.env.SANDBOX_IMAGE_CHROMIUM) {
      // Chromium keeps the legacy single-image configuration untouched.
      return this.image;
    }
    return getBrowserRegistryConfig().images[browserId];
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.dockerBin, args, {
      maxBuffer: 1024 * 1024,
      timeout: 30000,
      env: { ...process.env, DOCKER_DEFAULT_PLATFORM: process.env.DOCKER_DEFAULT_PLATFORM },
    });
  }
}

function parseDockerDate(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function configJobsWorkerId(): string | undefined {
  try {
    return getConfig().jobs.workerId;
  } catch {
    return undefined;
  }
}

export function createDockerDriver(image?: string): SandboxDriver {
  return new DockerSandboxDriver(image);
}
