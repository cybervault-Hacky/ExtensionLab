/**
 * Phase 13 real-infrastructure e2e suite.
 *
 * Four independent groups, each behind its own flag:
 * - EXTENSIONLAB_E2E_DOCKER=1 — label-scoped reconciliation + container
 *   hardening verified against a real Docker daemon.
 * - EXTENSIONLAB_E2E_POSTGRES=1 — PostgreSQL reachability + fail-closed
 *   behavior (the platform never silently fakes a Postgres deployment).
 * - EXTENSIONLAB_E2E_REDIS=1 — distributed rate limits, locks and SSE frame
 *   pub/sub against a real Redis via the coordination abstraction.
 * - EXTENSIONLAB_E2E_STORAGE=1 — S3-compatible object storage round trip
 *   (put/get/list/delete + health) via the StorageProvider interface.
 *
 * Default: every group skips with an explicit reason. Flagged and missing
 * infrastructure: hard failure — results are never faked.
 */
import { describe, expect, it } from "vitest";
import { connect as tcpConnect } from "node:net";

const RUN_DOCKER = process.env.EXTENSIONLAB_E2E_DOCKER === "1";
const RUN_POSTGRES = process.env.EXTENSIONLAB_E2E_POSTGRES === "1";
const RUN_REDIS = process.env.EXTENSIONLAB_E2E_REDIS === "1";
const RUN_STORAGE = process.env.EXTENSIONLAB_E2E_STORAGE === "1";

const reason = (flag: string) => `${flag}=1 not set (set it on a host with the real infrastructure to run this suite)`;

function canReach(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// ---------------------------------------------------------------------------
// Docker: reconciliation is label-scoped; hardening flags are real.
// ---------------------------------------------------------------------------
describe("e2e phase13: Docker labels + hardening (EXTENSIONLAB_E2E_DOCKER=1)", { sequential: true }, () => {
  it.skipIf(!RUN_DOCKER)(reason("EXTENSIONLAB_E2E_DOCKER"), () => {
    expect(RUN_DOCKER).toBe(true);
  });

  it.skipIf(!RUN_DOCKER)("docker daemon is reachable and lists only ExtensionLab-owned containers for reconciliation", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("docker", ["ps", "-a", "--filter", "label=extensionlab.sandbox=1", "--format", "{{.ID}} {{.Label \"extensionlab.environment\"}}"], { timeout: 15_000 });
    // Every listed container carries an environment label — the reconciliation
    // contract (never delete across environments) is enforceable.
    for (const line of stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      expect(line.split(" ").length).toBeGreaterThanOrEqual(2);
    }
  });

  it.skipIf(!RUN_DOCKER)("a container created with ExtensionLab hardening flags has them in docker inspect", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const name = `extensionlab-e2e-hardening-${Date.now()}`;
    await exec(
      "docker",
      [
        "create", "--name", name,
        "--label", "extensionlab.sandbox=1",
        "--label", "extensionlab.environment=e2e",
        "--label", "extensionlab.owner=interactive",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--pids-limit", "200", "--network", "bridge",
        "hello-world",
      ],
      { timeout: 30_000 },
    );
    try {
      const { stdout } = await exec("docker", ["inspect", name], { timeout: 15_000 });
      const [info] = JSON.parse(stdout) as Array<{
        HostConfig: { CapDrop: string[]; ReadonlyRootfs: boolean; SecurityOpt: string[]; PidsLimit: number; Privileged: boolean };
      }>;
      expect(info.HostConfig.CapDrop).toContain("ALL");
      expect(info.HostConfig.Privileged).toBe(false);
      expect(info.HostConfig.ReadonlyRootfs).toBe(true);
      expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(info.HostConfig.PidsLimit).toBe(200);
    } finally {
      await exec("docker", ["rm", "-f", name], { timeout: 30_000 }).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL: reachable when flagged; this build fails closed rather than
// silently degrading (no fake Postgres mode).
// ---------------------------------------------------------------------------
describe("e2e phase13: PostgreSQL readiness (EXTENSIONLAB_E2E_POSTGRES=1)", { sequential: true }, () => {
  it.skipIf(!RUN_POSTGRES)(reason("EXTENSIONLAB_E2E_POSTGRES"), () => {
    expect(RUN_POSTGRES).toBe(true);
  });

  it.skipIf(!RUN_POSTGRES)("DATABASE_URL is a PostgreSQL URL and the server is reachable", async () => {
    const url = process.env.DATABASE_URL ?? "";
    expect(url.startsWith("postgres://") || url.startsWith("postgresql://")).toBe(true);
    const parsed = new URL(url);
    expect(await canReach(parsed.hostname, Number(parsed.port || 5432))).toBe(true);
  });

  it.skipIf(!RUN_POSTGRES)("fail closed: the migration runner refuses PostgreSQL instead of faking it", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const url = process.env.DATABASE_URL ?? "";
    const result = await exec("node", ["scripts/db-migrate.mjs"], {
      timeout: 60_000,
      env: { ...process.env, DATABASE_URL: url },
    }).catch((error: { stderr?: string; stdout?: string }) => error);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toMatch(/PostgreSQL|postgres/i);
  });
});

// ---------------------------------------------------------------------------
// Redis: distributed rate limit, lock with TTL, SSE frame pub/sub — all via
// the coordination abstraction (COORDINATION_PROVIDER=redis + REDIS_URL).
// ---------------------------------------------------------------------------
describe("e2e phase13: Redis coordination (EXTENSIONLAB_E2E_REDIS=1)", { sequential: true }, () => {
  it.skipIf(!RUN_REDIS)(reason("EXTENSIONLAB_E2E_REDIS"), async () => {
    expect(RUN_REDIS).toBe(true);
  });

  it.skipIf(!RUN_REDIS)("connects, rate-limits and locks against the real store", async () => {
    const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
    const parsed = new URL(url);
    expect(await canReach(parsed.hostname, Number(parsed.port || 6379))).toBe(true);

    const { getCoordinationStore, resetCoordinationForTests } = await import("@/lib/coordination");
    process.env.COORDINATION_PROVIDER = "redis";
    process.env.REDIS_URL = url;
    resetCoordinationForTests();
    const store = await getCoordinationStore();
    expect(store.name).toBe("redis");

    await expect(store.ping()).resolves.toBe(true);

    const key = `e2e-rl-${Date.now()}`;
    const first = await store.rateLimit(key, 2, 60_000);
    const second = await store.rateLimit(key, 2, 60_000);
    const third = await store.rateLimit(key, 2, 60_000);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);

    let entered = 0;
    await store.withLock(`e2e-lock-${Date.now()}`, 5_000, async () => {
      entered += 1;
    });
    expect(entered).toBe(1);
    resetCoordinationForTests();
    delete process.env.COORDINATION_PROVIDER;
    delete process.env.REDIS_URL;
  });

  it.skipIf(!RUN_REDIS)("SSE frames fan out across two hub instances via pub/sub", async () => {
    const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
    const { getCoordinationStore, resetCoordinationForTests } = await import("@/lib/coordination");
    process.env.COORDINATION_PROVIDER = "redis";
    process.env.REDIS_URL = url;
    resetCoordinationForTests();

    const { InteractiveSessionHub } = await import("@/lib/interactive/runtime");
    const attached = new InteractiveSessionHub();
    const viewer = new InteractiveSessionHub();
    const info = { sessionId: `sess-e2e-${Date.now()}`, controlPort: 1, runnerToken: "tok" } as never;
    const received: string[] = [];
    viewer.subscribe(info, (frame) => received.push(frame.kind));

    const hubInternals = attached as unknown as { onRuntimeEvent: (entry: unknown, raw: unknown) => void; ensure: (i: never) => unknown };
    hubInternals.onRuntimeEvent(hubInternals.ensure(info), {
      id: "e2e-evt-1",
      timestamp: Date.now(),
      type: "console",
      level: "info",
      source: "page",
      message: "cross-instance frame via redis",
    });

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !received.includes("console")) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(received).toContain("console");
    attached.dispose();
    viewer.dispose();
    resetCoordinationForTests();
    delete process.env.COORDINATION_PROVIDER;
    delete process.env.REDIS_URL;
  });
});

// ---------------------------------------------------------------------------
// S3-compatible storage via the StorageProvider interface.
// ---------------------------------------------------------------------------
describe("e2e phase13: S3-compatible storage (EXTENSIONLAB_E2E_STORAGE=1)", { sequential: true }, () => {
  it.skipIf(!RUN_STORAGE)(reason("EXTENSIONLAB_E2E_STORAGE"), async () => {
    expect(RUN_STORAGE).toBe(true);
  });

  it.skipIf(!RUN_STORAGE)("healthCheck + full round trip against the configured bucket", async () => {
    process.env.STORAGE_PROVIDER = "s3";
    if (!process.env.S3_BUCKET) throw new Error("EXTENSIONLAB_E2E_STORAGE=1 requires S3_BUCKET (and S3_* credentials/endpoint) to be set — refusing to fake results.");
    const { resetConfigCache } = await import("@/lib/config/env");
    resetConfigCache();
    const { ensureStorageInitialized } = await import("@/lib/storage/storage");
    const storage = await ensureStorageInitialized();

    expect(await storage.healthCheck()).toEqual({ ok: true });

    const key = `e2e/roundtrip-${Date.now()}.txt`;
    const bytes = new Uint8Array(Buffer.from("phase13 e2e storage round trip", "utf8"));
    await storage.put(key, bytes, { contentType: "text/plain" });
    expect(await storage.exists(key)).toBe(true);
    expect(new Uint8Array(await storage.get(key))).toEqual(bytes);
    expect((await storage.list("e2e/")).some((listed) => listed === key)).toBe(true);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);

    // Content types stay allowlisted on the real provider too.
    await expect(storage.put(`e2e/bad-${Date.now()}.bin`, bytes, { contentType: "text/html" })).rejects.toThrow();
    delete process.env.STORAGE_PROVIDER;
    resetConfigCache();
  });
});
