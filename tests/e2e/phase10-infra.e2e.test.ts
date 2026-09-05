/**
 * Phase 10 real-infrastructure e2e suite.
 *
 * Three independent groups, each behind its own flag:
 * - EXTENSIONLAB_E2E_POSTGRES=1 — DATABASE_URL must point at a reachable
 *   PostgreSQL, and the platform must fail closed (loud, descriptive startup
 *   error) rather than silently degrading when the driver is not wired.
 * - EXTENSIONLAB_E2E_REDIS=1 — the coordination store must rate-limit and
 *   lock against a real Redis (COORDINATION_PROVIDER=redis + REDIS_URL).
 * - EXTENSIONLAB_E2E_WEBHOOKS=1 — a real HTTP receiver end-to-end: dispatch →
 *   durable delivery job → signed POST received and verified.
 *
 * Default: every group skips with an explicit reason. Flagged and missing
 * infrastructure: hard failure — results are never faked.
 */
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect as tcpConnect } from "node:net";

const RUN_POSTGRES = process.env.EXTENSIONLAB_E2E_POSTGRES === "1";
const RUN_REDIS = process.env.EXTENSIONLAB_E2E_REDIS === "1";
const RUN_WEBHOOKS = process.env.EXTENSIONLAB_E2E_WEBHOOKS === "1";

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

describe("e2e: PostgreSQL (EXTENSIONLAB_E2E_POSTGRES=1)", { sequential: true }, () => {
  it.skipIf(!RUN_POSTGRES)(reason("EXTENSIONLAB_E2E_POSTGRES"), () => {
    expect(RUN_POSTGRES).toBe(true);
  });

  it.skipIf(!RUN_POSTGRES)("DATABASE_URL is a PostgreSQL URL and the server is reachable", async () => {
    const url = process.env.DATABASE_URL ?? "";
    expect(url.startsWith("postgres://") || url.startsWith("postgresql://")).toBe(true);
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = Number(parsed.port || 5432);
    expect(await canReach(host, port)).toBe(true);
  });

  it.skipIf(!RUN_POSTGRES)("fail closed: the SQLite-only build refuses to boot silently against PostgreSQL", async () => {
    const { closeDb, getDb } = await import("@/lib/db/client");
    const { resetConfigCache } = await import("@/lib/config/env");
    process.env.APP_ENV = "development";
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "";
    resetConfigCache();
    expect(() => {
      try {
        getDb();
      } finally {
        closeDb();
        resetConfigCache();
      }
    }).toThrow(/PostgreSQL|driver/i);
  });
});

describe("e2e: Redis coordination (EXTENSIONLAB_E2E_REDIS=1)", { sequential: true }, () => {
  it.skipIf(!RUN_REDIS)(reason("EXTENSIONLAB_E2E_REDIS"), () => {
    expect(RUN_REDIS).toBe(true);
  });

  it.skipIf(!RUN_REDIS)("rate limits and locks against a real Redis", async () => {
    const { resetConfigCache } = await import("@/lib/config/env");
    process.env.COORDINATION_PROVIDER = "redis";
    // Default redis://localhost:6379 when REDIS_URL is unset, but require
    // reachability — flagged runs must not silently pass against nothing.
    const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
    expect(await canReach(url.hostname, Number(url.port || 6379))).toBe(true);
    resetConfigCache();

    const coordination = await import("@/lib/coordination/index");
    const { resetCoordinationForTests, getCoordinationStore } = coordination as unknown as {
      resetCoordinationForTests: () => void;
      getCoordinationStore: () => Promise<{
        name: string;
        rateLimit: (key: string, limit: number, windowMs: number) => Promise<{ ok: boolean; remaining: number }>;
        withLock: <T>(key: string, ttlMs: number, work: () => Promise<T>) => Promise<T>;
      }>;
    };
    resetCoordinationForTests();
    const store = await getCoordinationStore();
    expect(store.name).toBe("redis");
    const key = `e2e:redis:${Date.now()}`;
    let allowed = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const verdict = await store.rateLimit(key, 3, 60_000);
      if (verdict.ok) allowed += 1;
    }
    expect(allowed).toBe(3);
    expect(await store.withLock(`${key}:lock`, 5_000, async () => "ran")).toBe("ran");
    resetCoordinationForTests();
    process.env.COORDINATION_PROVIDER = "memory";
    resetConfigCache();
  });
});

describe("e2e: webhooks (EXTENSIONLAB_E2E_WEBHOOKS=1)", { sequential: true }, () => {
  it.skipIf(!RUN_WEBHOOKS)(reason("EXTENSIONLAB_E2E_WEBHOOKS"), () => {
    expect(RUN_WEBHOOKS).toBe(true);
  });

  it.skipIf(!RUN_WEBHOOKS)("signed delivery reaches a real HTTP receiver", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "el-e2e-wh-"));

    const harness = (await import("../phase10/helpers")).setupHarness();
    const received: Array<{ body: string; signature: string | null }> = [];

    const server = await new Promise<Server>((resolve, reject) => {
      const created = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const raw = req.headers["x-extensionlab-signature"];
          const signature = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
          received.push({ body: Buffer.concat(chunks).toString("utf8"), signature });
          res.writeHead(204);
          res.end();
        });
      });
      created.once("error", reject);
      created.listen(0, "127.0.0.1", () => resolve(created));
    });
    const port = (server.address() as { port: number }).port;

    try {
      const { createOrganization, setOrganizationPlan } = await import("@/lib/organizations/service");
      const owner = (await import("../phase10/helpers")).makeUser();
      const org = createOrganization({ userId: owner.id }, { name: "E2E Webhooks" });
      setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 5 });

      const { createWebhook } = await import("@/lib/webhooks/service");
      const created = await createWebhook(
        { userId: owner.id, organizationId: org.id },
        // Test env permits http + loopback destinations by design.
        { url: `http://127.0.0.1:${port}/hook`, events: ["report.created"] },
      );

      const { dispatchOrganizationEvent } = await import("@/lib/webhooks/dispatch");
      dispatchOrganizationEvent(org.id, "report.created", { reportId: "rep_e2e", organizationId: org.id });
      const { getDb } = await import("@/lib/db/client");
      const delivery = getDb().prepare("SELECT id FROM organization_webhook_deliveries WHERE organization_id = ?").get(org.id) as { id: string };
      expect(delivery).toBeDefined();

      const { processWebhookDelivery } = await import("@/lib/webhooks/deliver");
      const outcome = await processWebhookDelivery(delivery.id);
      expect(outcome).toBe("succeeded");
      expect(received).toHaveLength(1);

      const { verifyWebhookSignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.parse(received[0].body) as { id: string };
      const signature = String(received[0].signature ?? "");
      const timestamp = Number(/t=(\d+)/.exec(signature)?.[1] ?? 0);
      const eventId = /e=([^,]+)/.exec(signature)?.[1] ?? "";
      const mac = /v1=([a-f0-9]+)/.exec(signature)?.[1] ?? "";
      expect(eventId).toBe(payload.id);
      expect(verifyWebhookSignature(created.secret, timestamp, payload.id, received[0].body, `t=${timestamp},e=${eventId},v1=${mac}`)).toBe(true);
      // Tampered body fails verification (replay/tamper protection is real).
      expect(verifyWebhookSignature(created.secret, timestamp, payload.id, `${received[0].body} `, `t=${timestamp},e=${eventId},v1=${mac}`)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      harness.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
