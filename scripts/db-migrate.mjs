#!/usr/bin/env node
/**
 * Explicit migration runner: `npm run db:migrate`.
 *
 * Applies every pending SQL file from lib/db/migrations in lexical order
 * inside a transaction. Safe to run repeatedly, on a fresh database and on an
 * existing Phase 5 database. Existing rows are never modified or deleted.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();

function resolveDatabasePath(env) {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    if (url === ":memory:" || url === "sqlite::memory:") return ":memory:";
    if (url.startsWith("sqlite:")) return url.replace(/^sqlite:(\/\/)?/, "");
    if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
      console.error("DATABASE_URL points to PostgreSQL. This build ships the SQLite driver only; see docs/DEPLOYMENT.md.");
      process.exit(1);
    }
    return url;
  }
  return env.EXTENSIONLAB_DB_PATH?.trim() || env.DATABASE_PATH?.trim() || join(root, "data", "extensionlab.sqlite");
}

const dbPath = resolveDatabasePath(process.env);
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--status");

if (dbPath !== ":memory:") {
  mkdirSync(dirname(dbPath), { recursive: true });
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  );
`);

const applied = new Set(
  db.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name),
);
const dir = join(root, "lib", "db", "migrations");
const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

// Phase 13 § migration locking: hold the database write lock (BEGIN IMMEDIATE)
// for the whole run so concurrent migration runners serialize instead of
// racing on `applied` bookkeeping. busy_timeout (set above) bounds the wait;
// a second runner either waits, then sees every file applied, or fails loudly.
let pending = 0;
let holdingRunLock = false;
if (!dryRun) {
  db.exec("BEGIN IMMEDIATE");
  holdingRunLock = true;
}
try {
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`already applied ${file}`);
      continue;
    }
    pending += 1;
    if (dryRun) {
      console.log(`pending ${file}`);
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
    console.log(`applied ${file}`);
  }
  if (holdingRunLock) {
    db.exec("COMMIT");
    holdingRunLock = false;
  }
} catch (error) {
  if (holdingRunLock) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Connection is closing; the transaction is discarded either way.
    }
  }
  console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
  db.close();
  process.exit(1);
}

db.close();
if (dryRun) {
  console.log(pending === 0 ? "database schema is up to date" : `${pending} migration(s) pending`);
} else {
  console.log(`database ready (${files.length} migration(s) applied)`);
}
