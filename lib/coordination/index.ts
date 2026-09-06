import "server-only";
import { EventEmitter } from "node:events";
import { getConfig } from "@/lib/config/env";
import { checkRateLimit } from "@/lib/auth/rate-limit";

/**
 * Distributed coordination abstraction (Phase 10).
 *
 * Production deployments can run multiple web/worker replicas; shared rate
 * limiting and advisory locks then need a shared store (Redis or equivalent).
 * The in-memory implementation keeps single-process development and tests
 * dependency-free — it is the default and requires no infrastructure.
 *
 * Selecting `COORDINATION_PROVIDER=redis` requires the `redis` npm package
 * (not bundled; install it in the deployment image). Selecting it without the
 * package is a hard startup failure, never a silent fallback that would
 * silently weaken rate limiting.
 */

export interface CoordinationRateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface CoordinationStore {
  readonly name: "memory" | "redis";
  /** Fixed-window counter. Cheap, deterministic, good enough for API limits. */
  rateLimit(key: string, limit: number, windowMs: number): Promise<CoordinationRateLimitResult>;
  /** Phase 13 §54: bounded liveness probe for readiness reporting. */
  ping(): Promise<boolean>;
  /**
   * Advisory mutex around `work`. Memory: process-local mutex map. Redis:
   * SET NX PX with a bounded wait. Never used for correctness-critical
   * invariants (those rely on database transactions).
   */
  withLock<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T>;
  /**
   * Phase 13 §59: best-effort pub/sub for live SSE frames across web
   * instances. Optional so custom stores can omit it; callers must treat
   * these as fire-and-forget (live frames only — replay stays DB-based).
   */
  publish?(channel: string, message: string): Promise<void>;
  subscribe?(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<() => void>;
}

// ---------------------------------------------------------------------------

class MemoryCoordinationStore implements CoordinationStore {
  readonly name = "memory" as const;
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Shared bus for same-process pub/sub (tests simulate multi-instance). */
  private static readonly bus = new EventEmitter();

  async ping(): Promise<boolean> {
    return true;
  }

  async publish(channel: string, message: string): Promise<void> {
    MemoryCoordinationStore.bus.emit(channel, message);
  }

  async subscribe(channel: string, onMessage: (message: string) => void): Promise<() => void> {
    MemoryCoordinationStore.bus.on(channel, onMessage);
    return () => MemoryCoordinationStore.bus.off(channel, onMessage);
  }

  /**
   * Delegates to the SAME fixed-window implementation the per-process limiter
   * uses, so `resetRateLimit` (tests, ops tooling) clears both paths at once
   * and behavior is identical whether or not Redis is configured.
   */
  async rateLimit(key: string, limit: number, windowMs: number): Promise<CoordinationRateLimitResult> {
    return checkRateLimit(key, limit, windowMs);
  }

  async withLock<T>(key: string, _ttlMs: number, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }
}

// Redis adapter: loaded lazily so the dependency stays optional. When the
// package is absent the factory throws a descriptive error at startup.
class RedisCoordinationStore implements CoordinationStore {
  readonly name = "redis" as const;
  private static clientFactory: {
    createClient: (options: { url: string }) => {
      sendCommand: (args: Array<string | number>) => Promise<unknown>;
      connect?: () => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  } | null = null;
  private static clientUrl = "";
  private static subscriber: {
    sendCommand: (args: Array<string | number>) => Promise<unknown>;
  } | null = null;
  /** channel -> handlers (fan-out to multiple local subscribers). */
  private static readonly channels = new Map<string, Set<(message: string) => void>>();
  private readonly client: { sendCommand: (args: Array<string | number>) => Promise<unknown>; connect?: () => Promise<unknown> };
  private readonly prefix = "extensionlab:coord:";

  private static dispatch(channel: string, message: string): void {
    for (const handler of RedisCoordinationStore.channels.get(channel) ?? []) {
      try {
        handler(message);
      } catch {
        // Handler failures must never break the subscription.
      }
    }
  }

  constructor(client: { sendCommand: (args: Array<string | number>) => Promise<unknown>; connect?: () => Promise<unknown> }) {
    this.client = client;
  }

  static async create(url: string): Promise<RedisCoordinationStore> {
    type RedisClientFactory = { createClient: (options: { url: string }) => RedisCoordinationStore["client"] & { on: (event: string, handler: () => void) => void } };
    let redisModule: RedisClientFactory;
    try {
      // Optional peer dependency: resolved through a variable specifier so a
      // missing package degrades to this runtime error instead of a build break.
      const specifier = "redis";
      redisModule = (await import(/* @vite-ignore */ specifier)) as unknown as RedisClientFactory;
    } catch {
      throw new Error(
        "COORDINATION_PROVIDER=redis requires the 'redis' npm package in the deployment image (npm install redis). The in-memory provider keeps single-process deployments working without it.",
      );
    }
    const client = redisModule.createClient({ url });
    client.on("error", () => undefined);
    await client.connect?.();
    RedisCoordinationStore.clientFactory = redisModule;
    RedisCoordinationStore.clientUrl = url;
    return new RedisCoordinationStore(client);
  }

  async rateLimit(key: string, limit: number, windowMs: number): Promise<CoordinationRateLimitResult> {
    const window = Math.ceil(windowMs / 1000);
    const windowId = Math.floor(Date.now() / windowMs);
    const k = `${this.prefix}rl:${key}:${windowId}`;
    const count = Number(await this.client.sendCommand(["INCR", k]));
    if (count === 1) await this.client.sendCommand(["EXPIRE", k, window]);
    if (count > limit) {
      const ttl = Number(await this.client.sendCommand(["TTL", k]));
      return { ok: false, remaining: 0, retryAfterSeconds: Math.max(1, ttl) };
    }
    return { ok: true, remaining: limit - count, retryAfterSeconds: 0 };
  }

  async ping(): Promise<boolean> {
    const reply = await this.client.sendCommand(["PING"]);
    return reply === "PONG";
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.sendCommand(["PUBLISH", `${this.prefix}pub:${channel}`, message]);
  }

  async subscribe(channel: string, onMessage: (message: string) => void): Promise<() => void> {
    if (!RedisCoordinationStore.subscriber) {
      if (!RedisCoordinationStore.clientFactory) throw new Error("Redis pub/sub requires a connected RedisCoordinationStore.");
      const subscriber = RedisCoordinationStore.clientFactory.createClient({ url: RedisCoordinationStore.clientUrl });
      subscriber.on("message", (_channel: unknown, message: unknown) => {
        if (typeof message !== "string") return;
        RedisCoordinationStore.dispatch(String(_channel), message);
      });
      await subscriber.connect?.();
      RedisCoordinationStore.subscriber = subscriber;
    }
    const namespaced = `${this.prefix}pub:${channel}`;
    const handlers = RedisCoordinationStore.channels.get(namespaced) ?? new Set();
    handlers.add(onMessage);
    RedisCoordinationStore.channels.set(namespaced, handlers);
    await RedisCoordinationStore.subscriber.sendCommand(["SUBSCRIBE", namespaced]);
    return async () => {
      handlers.delete(onMessage);
      if (handlers.size === 0) {
        RedisCoordinationStore.channels.delete(namespaced);
        await RedisCoordinationStore.subscriber?.sendCommand(["UNSUBSCRIBE", namespaced]).catch(() => undefined);
      }
    };
  }

  async withLock<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T> {
    const lockKey = `${this.prefix}lock:${key}`;
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const acquired = await this.client.sendCommand(["SET", lockKey, token, "NX", "PX", ttlMs]);
    if (acquired === null || acquired === undefined) {
      // Bounded wait, then proceed without the lock: locks here only smooth
      // races; correctness is guaranteed by database transactions.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await work();
    } finally {
      await this.client.sendCommand(["GET", lockKey]).then(async (value) => {
        if (value === token) await this.client.sendCommand(["DEL", lockKey]);
      });
    }
  }
}

// ---------------------------------------------------------------------------

let store: CoordinationStore | null = null;
let initializing: Promise<CoordinationStore> | null = null;

export function getCoordinationStoreSync(): CoordinationStore {
  if (store) return store;
  const provider = getConfig().coordination.provider;
  if (provider === "memory") {
    store = new MemoryCoordinationStore();
    return store;
  }
  // Redis is async to initialize; callers awaiting getCoordinationStore() get
  // the real store. A synchronous access before initialization falls back to
  // memory ONLY in non-production environments to avoid crashing reads; in
  // production this is a hard error so misconfiguration is visible.
  if (getConfig().appEnv === "production") {
    throw new Error("Coordination store not initialized. Await getCoordinationStore() during startup.");
  }
  store = new MemoryCoordinationStore();
  return store;
}

export async function getCoordinationStore(): Promise<CoordinationStore> {
  if (store) return store;
  if (initializing) return initializing;
  const config = getConfig();
  if (config.coordination.provider === "redis") {
    if (!config.coordination.redisUrl) {
      throw new Error("COORDINATION_PROVIDER=redis requires REDIS_URL to be set.");
    }
    initializing = RedisCoordinationStore.create(config.coordination.redisUrl).then((created) => {
      store = created;
      return created;
    });
  } else {
    store = new MemoryCoordinationStore();
    initializing = Promise.resolve(store);
  }
  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

/** Test-only reset (keeps suites isolated). */
export function resetCoordinationForTests(): void {
  store = null;
  initializing = null;
}
