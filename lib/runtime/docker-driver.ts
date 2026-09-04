import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSandboxConfig } from "./config";
import { getFreePort } from "./ports";
import { ControlClient } from "./control-client";
import { waitForControl, type ContainerHandle, type SandboxDriver } from "./driver";

const execFileAsync = promisify(execFile);

/**
 * Docker-backed sandbox driver.
 *
 * The host process never runs extension code directly. It only manages a
 * fresh, non-privileged, read-only-root container with a loopback-only control
 * port. The extension source is copied into the container's disposable tmpfs.
 */
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
  ): Promise<ContainerHandle> {
    const config = getSandboxConfig();
    const controlPort = await getFreePort();
    const name = `extensionlab-${sandboxId}`;
    const network = config.networkMode === "none" ? "none" : "bridge";
    const token = `runner_${sandboxId}`;

    const args = [
      "create",
      "--name",
      name,
      "--label",
      "extensionlab.sandbox=1",
      "--network",
      network,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "node",
      "--init",
      "--pids-limit",
      "200",
      "--shm-size",
      "256m",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",
      "--tmpfs",
      "/home/node/.cache:rw,size=256m",
      "-m",
      config.defaultMemoryLimit,
      "--cpus",
      config.defaultCpuLimit,
      "-p",
      `127.0.0.1:${controlPort}:${config.runnerControlPort}`,
      "-e",
      `RUNNER_TOKEN=${token}`,
      "-e",
      "SANDBOX_ID=" + sandboxId,
      this.image,
    ];

    const created = await this.run(args);
    const containerId = created.stdout.trim();
    if (!containerId) {
      throw new Error("Docker returned an empty container id.");
    }

    // Copy extension source before the runner is asked to start.
    await this.run(["cp", `${sourcePath}/.`, `${containerId}:/tmp/extension`]);
    await this.run(["start", containerId]);

    const handle: ContainerHandle = {
      containerId,
      controlPort,
      controlClient: new ControlClient(controlPort),
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

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.dockerBin, args, {
      maxBuffer: 1024 * 1024,
      timeout: 30000,
      env: { ...process.env, DOCKER_DEFAULT_PLATFORM: process.env.DOCKER_DEFAULT_PLATFORM },
    });
  }
}

export function createDockerDriver(image?: string): SandboxDriver {
  return new DockerSandboxDriver(image);
}
