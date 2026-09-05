import "server-only";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");
const DatabaseSync = sqlite.DatabaseSync;

export type DB = import("node:sqlite").DatabaseSync;

declare global {
  // eslint-disable-next-line no-var
  var __extensionlabDb: DB | undefined;
}

export interface DatabaseOptions {
  path?: string;
  runMigrations?: boolean;
}

const MIGRATION_DIR = join(process.cwd(), "lib", "db", "migrations");

/**
 * Resolves the SQLite path. `DATABASE_URL` (sqlite:...) takes precedence,
 * followed by the Phase 5 variables. Kept dependency-free so the migration
 * script and the worker can share it.
 */
export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    if (url === ":memory:" || url === "sqlite::memory:") return ":memory:";
    if (url.startsWith("sqlite:")) return url.replace(/^sqlite:(\/\/)?/, "");
    return url;
  }
  return (
    env.EXTENSIONLAB_DB_PATH?.trim() ||
    env.DATABASE_PATH?.trim() ||
    join(process.cwd(), "data", "extensionlab.sqlite")
  );
}

export function getDb(options: DatabaseOptions = {}): DB {
  const configuredPath = options.path ?? resolveDatabasePath();

  if (globalThis.__extensionlabDb) {
    if (options.runMigrations !== false) ensureMigrations(globalThis.__extensionlabDb);
    return globalThis.__extensionlabDb;
  }

  if (configuredPath !== ":memory:") {
    mkdirSync(dirname(configuredPath), { recursive: true });
  }
  const db = new DatabaseSync(configuredPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  if (options.runMigrations !== false) ensureMigrations(db);

  globalThis.__extensionlabDb = db;
  return db;
}

export function closeDb(): void {
  if (globalThis.__extensionlabDb) {
    try {
      globalThis.__extensionlabDb.close();
    } catch {
      // Already closed.
    }
    globalThis.__extensionlabDb = undefined;
  }
}

/** True when a database handle is open in this process. */
export function isDbOpen(): boolean {
  return globalThis.__extensionlabDb !== undefined;
}

/** Lightweight connectivity probe used by readiness checks. */
export function pingDb(): boolean {
  try {
    const row = getDb().prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

/** Names of applied migrations (for readiness/ops output). */
export function listAppliedMigrations(): string[] {
  return (
    getDb()
      .prepare("SELECT name FROM schema_migrations ORDER BY id ASC")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function ensureMigrations(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    (
      db
        .prepare("SELECT name FROM schema_migrations")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );

  const files = readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATION_DIR, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Runs a group of statements inside a single transaction.
 *
 * Nested calls join the outer transaction (SQLite does not support nested
 * BEGIN), so repository helpers can be composed freely. `BEGIN IMMEDIATE` is
 * used so that concurrent writers (web + worker) serialize up front instead of
 * failing at commit time.
 */
export function transaction<T>(db: DB, work: () => T): T {
  if (db.isTransaction) {
    return work();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Connection may already be out of the transaction.
    }
    throw error;
  }
}
