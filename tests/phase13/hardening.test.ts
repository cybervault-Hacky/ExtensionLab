import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { buildSandboxCreateArgs } from "@/lib/runtime/docker-driver";
import { RESOURCE_PROFILES, memoryLimitToBytes, resolveResourceProfile } from "@/lib/runtime/profiles";
import { setupPhase13Harness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupPhase13Harness();
});

afterEach(() => {
  harness.teardown();
});

const baseArgs = {
  name: "extensionlab-sbx_test",
  image: "extensionlab-sandbox-chromium:13.0.0",
  controlPort: 45678,
  runnerToken: "tok",
  sandboxId: "sbx_test",
  browserId: "chromium",
  network: "bridge" as const,
  runnerControlPort: 9333,
  labels: { environment: "production", session: "sess_1", worker: "w-1", browser: "chromium", owner: "interactive" },
  defaultMemoryLimit: "768m",
  defaultCpuLimit: "0.5",
};

/** §13/§102: the container hardening contract, asserted against the exact
 * `docker create` argument list — no privileged mode, no host namespaces, no
 * docker socket, no host mounts, no device passthrough. */
describe("Phase 13 §13: browser container hardening baseline", () => {
  const args = buildSandboxCreateArgs(baseArgs);
  const joined = args.join(" ");

  it("drops all capabilities and blocks privilege escalation", () => {
    expect(args).toContain("--cap-drop");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).toContain("--security-opt");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(joined).not.toContain("--privileged");
    expect(joined).not.toContain("--cap-add");
  });

  it("runs non-root, read-only root filesystem, writable tmpfs only", () => {
    expect(args[args.indexOf("--user") + 1]).toBe("node");
    expect(args).toContain("--read-only");
    const tmpfsFlags = args.filter((_, index) => args[index - 1] === "--tmpfs");
    expect(tmpfsFlags.join(" ")).toMatch(/\/tmp:rw,noexec,nosuid/);
    expect(joined).not.toMatch(/-v\s|--volume/); // no bind mounts at all
  });

  it("applies CPU, memory and PID limits", () => {
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("768m");
    expect(args).toContain("--cpus");
    expect(args[args.indexOf("--cpus") + 1]).toBe("0.5");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("200");
  });

  it("never uses host namespaces, host networking, devices or the docker socket", () => {
    expect(joined).not.toContain("--network host");
    expect(joined).not.toContain("--pid=host");
    expect(joined).not.toContain("--ipc=host");
    expect(joined).not.toContain("--uts=host");
    expect(joined).not.toContain("--device");
    expect(joined).not.toContain("/var/run/docker.sock");
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
  });

  it("publishes the control port on loopback only", () => {
    const flag = args.find((value) => value.startsWith("127.0.0.1:"));
    expect(flag).toBeTruthy();
    expect(joined).not.toMatch(/-p\s+0\.0\.0\.0/);
  });
});

describe("Phase 13 §16: ownership labels for reconciliation", () => {
  it("labels every container with environment/session/worker/browser/owner", () => {
    const args = buildSandboxCreateArgs(baseArgs);
    const labelBlock = args.filter((_, index) => args[index - 1] === "--label").join(",");
    expect(labelBlock).toContain("extensionlab.sandbox=1");
    expect(labelBlock).toContain("extensionlab.environment=production");
    expect(labelBlock).toContain("extensionlab.session=sess_1");
    expect(labelBlock).toContain("extensionlab.worker=w-1");
    expect(labelBlock).toContain("extensionlab.browser=chromium");
    expect(labelBlock).toContain("extensionlab.owner=interactive");
  });
});

describe("Phase 13 §12/§62: resource profiles are server-controlled", () => {
  it("heavy profiles tighten limits but never weaken the baseline", () => {
    const heavy = buildSandboxCreateArgs({ ...baseArgs, profile: RESOURCE_PROFILES.heavy });
    expect(heavy[heavy.indexOf("-m") + 1]).toBe("1536m");
    expect(heavy[heavy.indexOf("--cpus") + 1]).toBe("1.0");
    expect(heavy[heavy.indexOf("--pids-limit") + 1]).toBe("400");
    // Hardening flags identical.
    expect(heavy).toContain("--cap-drop");
    expect(heavy).toContain("--read-only");
    expect(heavy[heavy.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
  });

  it("users cannot request heavy without the plan entitlement", () => {
    expect(resolveResourceProfile({ requested: "heavy", allowHeavy: false }).id).toBe("standard");
    expect(resolveResourceProfile({ requested: "heavy", allowHeavy: true }).id).toBe("heavy");
    expect(resolveResourceProfile({ requested: "gargantuan", allowHeavy: true }).id).toBe("standard");
    expect(resolveResourceProfile({}).id).toBe("standard");
  });

  it("memory limits parse to comparable byte values", () => {
    expect(memoryLimitToBytes("768m")).toBe(768 * 1024 ** 2);
    expect(memoryLimitToBytes("1536m")).toBeGreaterThan(memoryLimitToBytes("768m"));
    expect(memoryLimitToBytes("garbage")).toBe(0);
  });
});
