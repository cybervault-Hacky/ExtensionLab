import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DockerSandboxDriver } from "@/lib/runtime/docker-driver";

const root = process.cwd();

/**
 * Captures the exact `docker create` arguments the driver would use, without
 * a Docker daemon: `run` is replaced by a recorder, and creation is aborted at
 * the first call (the empty container id path).
 */
async function captureCreateArgs(): Promise<string[]> {
  const driver = new DockerSandboxDriver("extensionlab-sandbox:test");
  const calls: string[][] = [];
  (driver as unknown as { run: (args: string[]) => Promise<{ stdout: string; stderr: string }> }).run = async (args: string[]) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  await driver.create("sbx_test", "/tmp/does-not-matter", "runner-token").catch(() => undefined);
  const create = calls.find((args) => args[0] === "create");
  if (!create) throw new Error("driver never issued docker create");
  return create;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", "dist", "coverage"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("Docker sandbox hardening (Phase 3/4 guarantees preserved)", () => {
  it("creates containers as non-root with all capabilities dropped and no privilege escalation", async () => {
    const args = await captureCreateArgs();
    expect(flag(args, "--user")).toBe("node");
    expect(args).toContain("--cap-drop");
    expect(flag(args, "--cap-drop")).toBe("ALL");
    expect(flag(args, "--security-opt")).toBe("no-new-privileges");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--cap-add");
  });

  it("uses a read-only root filesystem with size-limited noexec tmpfs", async () => {
    const args = await captureCreateArgs();
    expect(args).toContain("--read-only");
    const tmpfs = args.filter((_, index) => args[index - 1] === "--tmpfs");
    expect(tmpfs.some((mount) => mount.startsWith("/tmp:") && mount.includes("noexec") && mount.includes("nosuid") && /size=\d+m/.test(mount))).toBe(true);
  });

  it("applies memory, CPU and PID limits", async () => {
    const args = await captureCreateArgs();
    expect(flag(args, "-m")).toMatch(/^\d+[mg]$/);
    expect(Number(flag(args, "--cpus"))).toBeGreaterThan(0);
    expect(Number(flag(args, "--pids-limit"))).toBeLessThanOrEqual(200);
    expect(args).toContain("--init");
  });

  it("never uses host networking, host mounts or the Docker socket", async () => {
    const args = await captureCreateArgs();
    expect(["none", "bridge"]).toContain(flag(args, "--network"));
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--mount");
    expect(args.join(" ")).not.toMatch(/docker\.sock/);
    expect(args.join(" ")).not.toMatch(/--pid[= ]host|--ipc[= ]host|--userns[= ]host/);
    // The control port is published on loopback only.
    const publish = flag(args, "-p");
    expect(publish).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
  });

  it("labels sandbox containers so orphans can be swept and passes no secrets except the runner token", async () => {
    const args = await captureCreateArgs();
    expect(flag(args, "--label")).toBe("extensionlab.sandbox=1");
    const envs = args.filter((_, index) => args[index - 1] === "-e");
    // Phase 9 adds EXTENSIONLAB_BROWSER (a validated, non-secret browser id).
    expect(envs.every((entry) => /^(RUNNER_TOKEN|SANDBOX_ID|EXTENSIONLAB_BROWSER)=/.test(entry))).toBe(true);
  });

  it("ships a sandbox image that runs as a non-root user without a shell entrypoint", () => {
    const dockerfile = readFileSync(join(root, "sandbox", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^USER node/m);
    expect(dockerfile).toMatch(/^CMD \["node"/m);
    expect(dockerfile).not.toMatch(/--privileged|docker\.sock/);
  });

  it("uses hardened application images (non-root, prod deps, web image without Docker CLI)", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    const webStage = dockerfile.slice(dockerfile.indexOf("AS web"), dockerfile.indexOf("AS worker"));
    expect(webStage).toMatch(/^USER extensionlab/m);
    // The web image must never contain the Docker CLI or the Docker socket.
    expect(webStage).not.toMatch(/download\.docker\.com|docker-ce|docker\.sock|\/usr\/local\/bin\/docker/);
    const workerStage = dockerfile.slice(dockerfile.indexOf("AS worker"));
    expect(workerStage).toMatch(/^USER extensionlab/m);
    expect(dockerfile).toMatch(/npm ci --omit=dev/);
    const compose = readFileSync(join(root, "docker-compose.prod.yml"), "utf8");
    const webService = compose.slice(compose.indexOf("\n  web:"), compose.indexOf("\n  worker:"));
    expect(webService).not.toMatch(/docker\.sock/);
    expect(webService).toMatch(/no-new-privileges/);
  });

  it("exposes no arbitrary command execution or raw Docker API routes", () => {
    const apiRoot = join(root, "app", "api");
    const routeDirs = walk(apiRoot).map((file) => file.slice(apiRoot.length).toLowerCase());
    for (const forbidden of ["/exec/", "/shell/", "/command/", "/docker/", "/containers/"]) {
      expect(routeDirs.some((dir) => dir.includes(forbidden))).toBe(false);
    }
    // Nothing under app/ or components/ shells out or reaches for the Docker CLI.
    const clientFacing = [...walk(join(root, "app")), ...walk(join(root, "components"))].filter((file) => /\.(ts|tsx)$/.test(file));
    for (const file of clientFacing) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/child_process|execSync|spawnSync|DOCKER_BIN|\bdockerode\b/);
    }
  });

  it("keeps container ids, hostnames and host paths out of client projections", () => {
    const files = [
      join(root, "lib", "testing", "run-service.ts"),
      join(root, "lib", "db", "repositories", "test-runs.ts"),
      join(root, "lib", "jobs", "queue.ts"),
      join(root, "lib", "observability", "readiness.ts"),
    ];
    for (const file of files) {
      expect(existsSync(file), file).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/containerId|hostname\(\)|os\.hostname|controlPort/);
    }
  });
});
