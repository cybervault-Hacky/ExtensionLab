import { getDb } from "../client";
import { generateDbId } from "../ids";
import type { SavedTestRow, SavedTestSuiteItemRow, SavedTestSuiteRow, SavedTestVersionRow } from "../schema/types";

/**
 * Phase 15 saved-test persistence. Definitions are stored as validated JSON;
 * version rows are immutable (insert-only). All listing paths are bounded and
 * server-side paginated.
 */

export interface SavedTestFilter {
  page: number;
  limit: number;
  search?: string;
  status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  tag?: string;
  browserId?: string;
  suiteId?: string;
}

export function getSavedTestById(id: string): SavedTestRow | null {
  return (getDb().prepare("SELECT * FROM saved_tests WHERE id = ?").get(id) as SavedTestRow | undefined) ?? null;
}

/** Organization-scoped read: org tests are visible to members; personal tests to their owner. */
export function getAccessibleSavedTest(viewer: { userId: string; organizationId: string | null }, id: string): SavedTestRow | null {
  const row = getSavedTestById(id);
  if (!row) return null;
  if (row.organization_id) return row.organization_id === viewer.organizationId ? row : null;
  return row.user_id === viewer.userId ? row : null;
}

export function createSavedTest(input: {
  id?: string;
  organizationId: string | null;
  userId: string;
  extensionId: string | null;
  packageId: string;
  packageSha256: string;
  packageVersion: string | null;
  name: string;
  description: string;
  tags: string[];
  browserTargets: string[];
  definitionJson: string;
  now?: number;
}): SavedTestRow {
  const db = getDb();
  const now = input.now ?? Date.now();
  const id = input.id ?? generateDbId("st");
  db.prepare(
    `INSERT INTO saved_tests (
       id, organization_id, user_id, extension_id, package_id, package_sha256, package_version,
       name, description, status, current_version, tags_json, browser_targets_json, definition_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 1, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.organizationId, input.userId, input.extensionId, input.packageId, input.packageSha256, input.packageVersion,
    input.name, input.description, JSON.stringify(input.tags), JSON.stringify(input.browserTargets), input.definitionJson, now, now,
  );
  db.prepare(
    "INSERT INTO saved_test_versions (id, test_id, version, definition_json, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?)",
  ).run(generateDbId("stv"), id, input.definitionJson, input.userId, now);
  return getSavedTestById(id)!;
}

export function updateSavedTest(
  id: string,
  fields: {
    name?: string;
    description?: string;
    status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
    tags?: string[];
    browserTargets?: string[];
    definitionJson?: string;
    /** Bump = write a new immutable version row. */
    bumpVersion?: boolean;
  },
): SavedTestRow | null {
  const db = getDb();
  const existing = getSavedTestById(id);
  if (!existing) return null;
  const now = Date.now();
  const sets: string[] = ["updated_at = ?"];
  const values: Array<string | number> = [now];
  if (fields.name !== undefined) { sets.push("name = ?"); values.push(fields.name); }
  if (fields.description !== undefined) { sets.push("description = ?"); values.push(fields.description); }
  if (fields.status !== undefined) { sets.push("status = ?"); values.push(fields.status); }
  if (fields.tags !== undefined) { sets.push("tags_json = ?"); values.push(JSON.stringify(fields.tags)); }
  if (fields.browserTargets !== undefined) { sets.push("browser_targets_json = ?"); values.push(JSON.stringify(fields.browserTargets)); }
  if (fields.definitionJson !== undefined) { sets.push("definition_json = ?"); values.push(fields.definitionJson); }
  let newVersion = existing.current_version;
  if (fields.bumpVersion && fields.definitionJson !== undefined) {
    newVersion += 1;
    sets.push("current_version = ?");
    values.push(newVersion);
  }
  values.push(id);
  db.prepare(`UPDATE saved_tests SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  if (fields.bumpVersion && fields.definitionJson !== undefined) {
    db.prepare(
      "INSERT INTO saved_test_versions (id, test_id, version, definition_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(generateDbId("stv"), id, newVersion, fields.definitionJson, existing.user_id, now);
  }
  return getSavedTestById(id);
}

export function getSavedTestVersion(testId: string, version: number): SavedTestVersionRow | null {
  return (getDb().prepare("SELECT * FROM saved_test_versions WHERE test_id = ? AND version = ?").get(testId, version) as SavedTestVersionRow | undefined) ?? null;
}

export function listSavedTestVersions(testId: string): SavedTestVersionRow[] {
  return getDb().prepare("SELECT * FROM saved_test_versions WHERE test_id = ? ORDER BY version DESC").all(testId) as unknown as SavedTestVersionRow[];
}

export interface SavedTestListResult {
  items: SavedTestRow[];
  total: number;
  page: number;
  limit: number;
}

export function listSavedTests(viewer: { userId: string; organizationId: string | null }, filter: SavedTestFilter): SavedTestListResult {
  const db = getDb();
  const limit = Math.min(Math.max(filter.limit, 1), 50);
  const offset = (Math.max(filter.page, 1) - 1) * limit;
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.suiteId) {
    where.push("id IN (SELECT test_id FROM saved_test_suite_items WHERE suite_id = ?)");
    params.push(filter.suiteId);
  }
  if (filter.search) {
    where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    const term = `%${filter.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    params.push(term, term);
  }
  if (filter.status) { where.push("status = ?"); params.push(filter.status); }
  if (filter.tag) { where.push("tags_json LIKE ?"); params.push(`%"${filter.tag}"%`); }
  if (filter.browserId) { where.push("browser_targets_json LIKE ?"); params.push(`%"${filter.browserId}"%`); }
  where.push(viewer.organizationId ? "(organization_id = ? OR (organization_id IS NULL AND user_id = ?))" : "(organization_id IS NULL AND user_id = ?)");
  if (viewer.organizationId) params.push(viewer.organizationId, viewer.userId);
  else params.push(viewer.userId);

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM saved_tests ${whereSql}`).get(...params) as { total: number }).total;
  const items = db
    .prepare(`SELECT * FROM saved_tests ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as SavedTestRow[];
  return { items, total, page: Math.max(filter.page, 1), limit };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

export function createSavedTestSuite(input: {
  organizationId: string | null;
  userId: string;
  name: string;
  description: string;
  failurePolicy: "stop" | "continue";
}): SavedTestSuiteRow {
  const db = getDb();
  const now = Date.now();
  const id = generateDbId("sts");
  db.prepare(
    "INSERT INTO saved_test_suites (id, organization_id, user_id, name, description, failure_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.organizationId, input.userId, input.name, input.description, input.failurePolicy, now, now);
  return getSavedTestSuiteById(id)!;
}

export function getSavedTestSuiteById(id: string): SavedTestSuiteRow | null {
  return (getDb().prepare("SELECT * FROM saved_test_suites WHERE id = ?").get(id) as SavedTestSuiteRow | undefined) ?? null;
}

export function getAccessibleSavedTestSuite(viewer: { userId: string; organizationId: string | null }, id: string): SavedTestSuiteRow | null {
  const row = getSavedTestSuiteById(id);
  if (!row) return null;
  if (row.organization_id) return row.organization_id === viewer.organizationId ? row : null;
  return row.user_id === viewer.userId ? row : null;
}

export function listSavedTestSuites(viewer: { userId: string; organizationId: string | null }, limit = 50): SavedTestSuiteRow[] {
  const db = getDb();
  return db
    .prepare(
      viewer.organizationId
        ? "SELECT * FROM saved_test_suites WHERE organization_id = ? OR (organization_id IS NULL AND user_id = ?) ORDER BY updated_at DESC LIMIT ?"
        : "SELECT * FROM saved_test_suites WHERE organization_id IS NULL AND user_id = ? ORDER BY updated_at DESC LIMIT ?",
    )
    .all(...(viewer.organizationId ? [viewer.organizationId, viewer.userId, limit] : [viewer.userId, limit])) as unknown as SavedTestSuiteRow[];
}

/** Replaces the suite's membership; position = array index (deterministic ordering, §24). */
export function setSavedTestSuiteItems(suiteId: string, items: Array<{ testId: string; dependsOn?: string[] }>): void {
  const db = getDb();
  db.prepare("DELETE FROM saved_test_suite_items WHERE suite_id = ?").run(suiteId);
  items.forEach((item, index) => {
    db.prepare("INSERT INTO saved_test_suite_items (id, suite_id, test_id, position, depends_on_json) VALUES (?, ?, ?, ?, ?)").run(
      generateDbId("sti"), suiteId, item.testId, index, JSON.stringify(item.dependsOn ?? []),
    );
  });
  db.prepare("UPDATE saved_test_suites SET updated_at = ? WHERE id = ?").run(Date.now(), suiteId);
}

export function listSavedTestSuiteItems(suiteId: string): SavedTestSuiteItemRow[] {
  return getDb().prepare("SELECT * FROM saved_test_suite_items WHERE suite_id = ? ORDER BY position ASC").all(suiteId) as unknown as SavedTestSuiteItemRow[];
}

// ---------------------------------------------------------------------------
// Analytics (deterministic aggregates over immutable runs)
// ---------------------------------------------------------------------------

export interface SavedTestAnalytics {
  totalRuns: number;
  passed: number;
  failed: number;
  timeout: number;
  error: number;
  averageDurationMs: number | null;
  lastRunAt: number | null;
  lastFailureAt: number | null;
  /** Deterministic flaky suspect over recent runs (§85). */
  flakySuspect: boolean;
  recentSequence: string[];
}

export function getSavedTestAnalytics(testId: string, sequenceWindow = 8): SavedTestAnalytics {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT outcome, started_at, completed_at, created_at FROM test_runs
       WHERE saved_test_id = ? AND outcome IS NOT NULL
       ORDER BY created_at DESC LIMIT 50`,
    )
    .all(testId) as unknown as Array<{ outcome: string; started_at: number | null; completed_at: number | null; created_at: number }>;
  const sequence = rows.slice(0, sequenceWindow).map((row) => row.outcome).reverse();
  const durations = rows
    .map((row) => (typeof row.started_at === "number" && typeof row.completed_at === "number" ? row.completed_at - row.started_at : 0))
    .filter((duration) => duration > 0);
  return {
    totalRuns: rows.length,
    passed: rows.filter((row) => row.outcome === "PASSED").length,
    failed: rows.filter((row) => row.outcome === "FAILED").length,
    timeout: rows.filter((row) => row.outcome === "TIMEOUT").length,
    error: rows.filter((row) => row.outcome === "INFRASTRUCTURE_ERROR" || row.outcome === "ERROR").length,
    averageDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    lastRunAt: rows.length > 0 ? rows[0].created_at : null,
    lastFailureAt: rows.find((row) => row.outcome === "FAILED")?.created_at ?? null,
    flakySuspect: isFlakySuspect(sequence),
    recentSequence: sequence,
  };
}

/**
 * Deterministic flaky detection: alternating pass/fail at least 3 times over
 * the recent window with at least 4 runs. One failure never flags a test.
 */
export function isFlakySuspect(sequence: string[]): boolean {
  if (sequence.length < 4) return false;
  let alternations = 0;
  for (let i = 1; i < sequence.length; i += 1) {
    const previous = sequence[i - 1] === "PASSED" ? "P" : sequence[i - 1] === "FAILED" ? "F" : "";
    const current = sequence[i] === "PASSED" ? "P" : sequence[i] === "FAILED" ? "F" : "";
    if ((previous === "P" && current === "F") || (previous === "F" && current === "P")) alternations += 1;
  }
  return alternations >= 3;
}
