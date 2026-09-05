/**
 * Structured JSON logger shared by the web process and the worker.
 *
 * Every line contains: ts, level, event, plus optional correlation fields
 * (requestId, jobId, userId), duration, result and errorCode. Values whose key
 * looks sensitive are redacted, and long strings are truncated so that neither
 * secrets nor extension source can end up in log storage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|cookie|authorization|auth|api[-_]?key|credential|session|set-cookie|private[-_]?key|source|body|payload|analysis_json|report_json|result_json)/i;

const MAX_STRING = 400;
const MAX_DEPTH = 4;

export interface LogContext {
  requestId?: string;
  jobId?: string;
  userId?: string;
  runId?: string;
  component?: string;
}

export interface LogFields extends LogContext {
  durationMs?: number;
  result?: string;
  errorCode?: string;
  [key: string]: unknown;
}

type Sink = (line: string, level: LogLevel) => void;

const storage = new AsyncLocalStorage<LogContext>();

let minLevel: LogLevel = resolveLevel();
let sink: Sink = defaultSink;
const metricHooks = new Set<(name: string, value: number, tags: Record<string, string>) => void>();

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return "warn";
  return "info";
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function setLogSink(next: Sink | null): void {
  sink = next ?? defaultSink;
}

/** Registers a metrics hook. Metrics are emitted as `metric.*` log events too. */
export function onMetric(hook: (name: string, value: number, tags: Record<string, string>) => void): () => void {
  metricHooks.add(hook);
  return () => metricHooks.delete(hook);
}

export function recordMetric(name: string, value: number, tags: Record<string, string> = {}): void {
  for (const hook of metricHooks) {
    try {
      hook(name, value, tags);
    } catch {
      // Metrics must never affect the request/job path.
    }
  }
  log("debug", "metric", { metric: name, value, ...tags });
}

export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactValue("message", value.message, depth + 1) };
  }
  if (depth >= MAX_DEPTH) return "[object]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(key, item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const context = storage.getStore() ?? {};
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  for (const [key, value] of Object.entries({ ...context, ...fields })) {
    if (value === undefined) continue;
    record[key] = redactValue(key, value);
  }
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, event, error: "unserializable log record" });
  }
  sink(line, level);
}

export const logger = {
  debug: (event: string, fields?: LogFields) => log("debug", event, fields),
  info: (event: string, fields?: LogFields) => log("info", event, fields),
  warn: (event: string, fields?: LogFields) => log("warn", event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
  child(context: LogContext) {
    return {
      debug: (event: string, fields?: LogFields) => log("debug", event, { ...context, ...fields }),
      info: (event: string, fields?: LogFields) => log("info", event, { ...context, ...fields }),
      warn: (event: string, fields?: LogFields) => log("warn", event, { ...context, ...fields }),
      error: (event: string, fields?: LogFields) => log("error", event, { ...context, ...fields }),
    };
  },
};

/** Runs `fn` with the given correlation context attached to every log line. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...context }, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Request identifiers are short, random and safe to echo back to clients. */
export function generateRequestId(): string {
  return `req_${randomBytes(6).toString("hex")}`;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{6,64}$/;

/** Accepts a client-provided X-Request-ID when it is safe; otherwise generates one. */
export function resolveRequestId(header: string | null | undefined): string {
  if (header && REQUEST_ID_PATTERN.test(header)) return header;
  return generateRequestId();
}
