import { describe, expect, it } from "vitest";
import { DockerSandboxDriver } from "@/lib/runtime/docker-driver";
import { getBrowserProfile } from "@/lib/browsers/registry";
import { buildExecutionEvidence } from "@/lib/testing/matrix-service";
import { sanitizeCrossBrowser } from "@/lib/reports/views";

/**
 * Phase 9 adds browsers without weakening a single Phase 3 control: every
 * per-browser container gets the identical hardening, and nothing about the
 * infrastructure (images, hosts, container ids, paths) reaches users.
 */

async function captureCreateArgs(browserId?: string): Promise<string[]> {
  const driver = new DockerSandboxDriver("extensionlab-sandbox:test");
  const calls: string[][] = [];
  (driver as unknown as { run: (args: string[]) => Promise<{ stdout: string; stderr: string }> }).run = async (args: string[]) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  await driver
    .create("sbx_test", "/tmp/does-not-matter", "runner-token", browserId ? { browserId: browserId as never } : undefined)
    .catch(() => undefined);
  const create = calls.find((args) => args[0] === "create");
  if (!create) throw new Error("driver never issued docker create");
  return create;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

describe("per-browser containers keep every Phase 3 security control", () => {
  const HARDENING = [
    (args: string[]) => expect(flag(args, "--user")).toBe("node"),
    (args: string[]) => expect(flag(args, "--cap-drop")).toBe("ALL"),
    (args: string[]) => expect(flag(args, "--security-opt")).toBe("no-new-privileges"),
    (args: string[]) => expect(args).toContain("--read-only"),
    (args: string[]) => expect(args).not.toContain("--privileged"),
    (args: string[]) => expect(args).not.toContain("--cap-add"),
    (args: string[]) => expect(["none", "bridge"]).toContain(flag(args, "--network")),
    (args: string[]) => expect(args.join(" ")).not.toMatch(/docker\.sock/),
    (args: string[]) => expect(args).not.toContain("-v"),
    (args: string[]) => expect(Number(flag(args, "--pids-limit"))).toBeLessThanOrEqual(200),
    (args: string[]) => expect(flag(args, "-p")).toMatch(/^127\.0\.0\.1:\d+:\d+$/),
    (args: string[]) =>
      expect(args.filter((_, index) => args[index - 1] === "--tmpfs").some((mount) => mount.includes("noexec") && /size=\d+m/.test(mount))).toBe(true),
  ];

  it("applies identical hardening for chromium, edge and firefox", async () => {
    for (const browserId of ["chromium", "edge", "firefox"] as const) {
      const args = await captureCreateArgs(browserId);
      for (const check of HARDENING) check(args);
    }
  });

  it("pins a dedicated image per browser (Edge never rides the Chromium image implicitly)", async () => {
    const images = {} as Record<string, string>;
    for (const browserId of ["chromium", "edge", "firefox"] as const) {
      const args = await captureCreateArgs(browserId);
      const image = args[args.length - 1];
      images[browserId] = image;
    }
    // No env overrides in tests: chromium falls back to the legacy deployment
    // image; edge/firefox use their own dedicated pinned images.
    expect(images.chromium).toBe("extensionlab-sandbox:test");
    expect(images.edge).toMatch(/edge/i);
    expect(images.firefox).toMatch(/firefox/i);
    expect(images.edge).not.toBe(images.chromium);
    expect(images.firefox).not.toBe(images.chromium);
    expect(images.edge).not.toBe(images.firefox);
  });

  it("selects the browser only through the validated env var, never user flags", async () => {
    const args = await captureCreateArgs("firefox");
    const envs = args.filter((_, index) => args[index - 1] === "-e");
    expect(envs).toContain("EXTENSIONLAB_BROWSER=firefox");
    // No user-supplied browser flags, prefs or command-line switches exist.
    expect(envs.every((entry) => /^(RUNNER_TOKEN=.+|SANDBOX_ID=.+|EXTENSIONLAB_BROWSER=[a-z]+)$/.test(entry))).toBe(true);
    expect(envs.filter((entry) => entry.startsWith("EXTENSIONLAB_BROWSER="))).toHaveLength(1);
    // Unknown browser ids fall back to chromium rather than executing anything.
    const fallback = await captureCreateArgs("safari");
    expect(fallback.filter((_, index) => fallback[index - 1] === "-e")).toContain("EXTENSIONLAB_BROWSER=chromium");
  });

  it("keeps per-browser timeouts bounded", () => {
    for (const browserId of ["chromium", "edge", "firefox"] as const) {
      const profile = getBrowserProfile(browserId);
      expect(profile.defaultTimeouts.startupMs).toBeGreaterThan(0);
      expect(profile.defaultTimeouts.startupMs).toBeLessThanOrEqual(120_000);
      expect(profile.defaultTimeouts.executionMs).toBeGreaterThan(0);
    }
  });
});

describe("cross-browser evidence hygiene", () => {
  it("bounds and redacts stored execution evidence", () => {
    const consoleEvents = Array.from({ length: 500 }, (_, index) => ({
      id: `e${index}`,
      timestamp: index,
      type: "console",
      level: "error",
      source: "page",
      message: `Error ${index} ${"x".repeat(2000)}`,
    }));
    const network = Array.from({ length: 500 }, (_, index) => ({
      id: `n${index}`,
      timestamp: index,
      method: "GET",
      url: `https://api.example.com/v1/${"path".repeat(400)}/${index}`,
      status: 200,
      resourceType: "xhr",
      duration: index,
    }));
    const evidence = JSON.parse(
      buildExecutionEvidence({ consoleEvents: consoleEvents as never, network: network as never, screenshotCount: 99 }),
    ) as { consoleEvents: unknown[]; network: Array<{ url: string }> };
    expect(evidence.consoleEvents.length).toBeLessThanOrEqual(100);
    expect(evidence.network.length).toBeLessThanOrEqual(100);
    for (const entry of evidence.network) expect(entry.url.length).toBeLessThanOrEqual(512);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/authorization|cookie|set-cookie|token/i);
  });
});

describe("public cross-browser report sanitization", () => {
  const internalPayload = {
    kind: "cross-browser-matrix",
    matrixRunId: "matrix_123",
    browsers: [
      { browserId: "chromium", version: "139.0", engine: "chromium", status: "completed", executed: true },
      { browserId: "firefox", version: "141.0", engine: "gecko", status: "skipped", executed: false },
    ],
    compatibility: { score: 100, coverage: 0.5, browsersPassing: ["chromium"], browsersFailing: [], browsersUnavailable: ["firefox"], basis: "deterministic" },
  };

  it("keeps browser metadata but strips infrastructure detail", () => {
    const view = sanitizeCrossBrowser(internalPayload) as { browsers: Array<{ browserId: string }>; compatibility: { score: number } } | null;
    expect(view).not.toBeNull();
    expect(view!.browsers.map((browser) => browser.browserId)).toEqual(["chromium", "firefox"]);
    expect(view!.compatibility.score).toBe(100);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(/sandbox|container|docker|host|9333|\/var\//i);
  });

  it("returns null for missing sections and drops unknown fields", () => {
    expect(sanitizeCrossBrowser(null)).toBeNull();
    expect(sanitizeCrossBrowser("oops")).toBeNull();
    // Unknown fields are dropped; only the safe projection survives.
    const noisy = sanitizeCrossBrowser({ ...internalPayload, containerHost: "internal:9333", imageId: "sha256:deadbeef" });
    const serialized = JSON.stringify(noisy);
    expect(serialized).not.toMatch(/containerHost|imageId|sha256/);
  });
});
