import { rmSync } from "node:fs";
import { join } from "node:path";

const dbPath = process.env.EXTENSIONLAB_DB_PATH?.trim()
  || process.env.DATABASE_PATH?.trim()
  || join(process.cwd(), "data", "extensionlab.sqlite");

for (const suffix of ["", "-wal", "-shm"]) {
  try { rmSync(dbPath + suffix); } catch {}
}
(globalThis as any).__extensionlabDb = undefined;
