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

export function getDb(options: DatabaseOptions = {}): DB {
  const configuredPath =
    options.path ??
    process.env.EXTENSIONLAB_DB_PATH ??
    process.env.DATABASE_PATH ??
    join(process.cwd(), "data", "extensionlab.sqlite");

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
    globalThis.__extensionlabDb.close();
    globalThis.__extensionlabDb = undefined;
  }
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

/** Runs a group of statements inside a single transaction. */
export function transaction<T>(db: DB, work: () => T): T {
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
