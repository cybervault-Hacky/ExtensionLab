#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const dbPath =
  process.env.EXTENSIONLAB_DB_PATH ??
  process.env.DATABASE_PATH ??
  join(root, "data", "extensionlab.sqlite");

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

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = readFileSync(join(dir, file), "utf8");
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
    db.exec("COMMIT");
    console.log(`applied ${file}`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

db.close();
console.log(`database ready at ${dbPath}`);
