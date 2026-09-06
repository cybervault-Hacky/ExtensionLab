import "server-only";
import {
  createSavedTest,
  createSavedTestSuite,
  getAccessibleSavedTest,
  getAccessibleSavedTestSuite,
  getSavedTestAnalytics,
  getSavedTestById,
  getSavedTestVersion,
  listSavedTestSuiteItems,
  listSavedTestSuites,
  listSavedTests,
  listSavedTestVersions,
  setSavedTestSuiteItems,
  updateSavedTest,
  type SavedTestListResult,
} from "@/lib/db/repositories/saved-tests";
import type { ExtensionPackageRow, SavedTestRow, SavedTestSuiteRow } from "@/lib/db/schema/types";
import { canUseCrossBrowser, getMaxBrowsersPerRun } from "@/lib/billing/entitlements";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { readPackageBytes } from "@/lib/packages/service";
import { ensureEmbeddedWorker } from "@/lib/jobs/runtime";
import { recordAuditEvent } from "@/lib/db/repositories/audit";
import { BROWSER_IDS, isBrowserId, type BrowserId } from "@/lib/browsers/types";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { testConfig } from "./config";
import { buildSavedTestRunSummary, compareSavedTestRuns, getSavedTestBaseline, setSavedTestBaseline, type SavedTestRunSummary } from "./studio-baseline";
import { getDb } from "@/lib/db/client";
import { validateDefinition, validateTags, resolveVariables, SAVED_TEST_LIMITS, SAVED_TEST_SCHEMA_VERSION, SavedTestValidationError, type SavedTestDefinition } from "./saved-test-schema";
import { createQueuedTestRun, type PreparedSavedTest, type PreparedSavedTestMember } from "./run-service";
import type { ExtensionAnalysis } from "@/types/extension";

/**
 * Test Automation Studio service (Phase 15).
 *
 * Centralizes saved-test lifecycle (create → draft → active → version →
 * archive/duplicate), validation, variable resolution, execution against the
 * exact package SHA-256 the test was authored for, import/export, suites and
 * baselines. Routes contain no business logic — only this service decides
 * what a valid saved test is and how one runs.
 */

/** Audit events carry metadata only — never definitions, variables or URLs. */
function audit(userId: string, organizationId: string | null, type: Parameters<typeof recordAuditEvent>[0]["type"], details: Record<string, unknown>): void {
  recordAuditEvent({ userId, type, detail: JSON.stringify({ organizationId, ...details }) });
}

export interface StudioViewer {
  userId: string;
  organizationId: string | null;
  role?: string | null;
}

export interface SavedTestInput {
  name: string;
  description: string;
  tags: string[];
  browserTargets: string[];
  definition: unknown;
}

const NAME_PATTERN = /^[\w ,.\-()[\]]{1,120}$/;

function validateName(name: unknown): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name.trim())) {
    throw new AppError("INVALID_INPUT", { message: "Test names allow 1-120 letters, digits, spaces and .,_-() characters." });
  }
  return name.trim();
}

function validateDescription(description: unknown): string {
  if (description === undefined || description === null) return "";
  if (typeof description !== "string" || description.length > SAVED_TEST_LIMITS.maxDescriptionLength) {
    throw new AppError("INVALID_INPUT", { message: `Descriptions are limited to ${SAVED_TEST_LIMITS.maxDescriptionLength} characters.` });
  }
  return description.trim();
}

function validateBrowserTargets(raw: unknown): BrowserId[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError("INVALID_INPUT", { message: "Select at least one browser." });
  }
  if (raw.length > SAVED_TEST_LIMITS.maxBrowsersPerTest) {
    throw new AppError("INVALID_INPUT", { message: `At most ${SAVED_TEST_LIMITS.maxBrowsersPerTest} browsers per test.` });
  }
  const seen = new Set<string>();
  const targets: BrowserId[] = [];
  for (const value of raw) {
    if (!isBrowserId(value)) throw new AppError("INVALID_INPUT", { message: `Unsupported browser "${String(value)}". Supported: ${BROWSER_IDS.join(", ")}.` });
    if (seen.has(value)) continue;
    seen.add(value);
    targets.push(value);
  }
  return targets;
}

/** Cross-browser targets beyond Chromium require the plan entitlement. */
function assertBrowserEntitlement(userId: string, targets: BrowserId[]): void {
  if (targets.length > 1 || (targets.length === 1 && targets[0] !== "chromium")) {
    const entitlement = canUseCrossBrowser(userId);
    if (!entitlement.allowed) {
      throw new AppError("FORBIDDEN", { message: entitlement.reason ?? "Cross-browser testing requires a plan upgrade." });
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createStudioTest(viewer: StudioViewer, input: SavedTestInput, packageId: string): Promise<SavedTestRow> {
  const name = validateName(input.name);
  const description = validateDescription(input.description);
  const tags = validateTags(input.tags);
  const browserTargets = validateBrowserTargets(input.browserTargets);
  assertBrowserEntitlement(viewer.userId, browserTargets);
  let definition: SavedTestDefinition;
  try {
    definition = validateDefinition(input.definition);
  } catch (error) {
    if (error instanceof SavedTestValidationError) throw new AppError("INVALID_INPUT", { message: error.message });
    throw error;
  }
  const { analysis, row } = await loadAndVerifyPackage(viewer, packageId);

  const created = createSavedTest({
    organizationId: viewer.organizationId,
    userId: viewer.userId,
    extensionId: row.extension_id,
    packageId,
    packageSha256: row.sha256,
    packageVersion: analysis.metadata.version ?? row.version,
    name,
    description,
    tags,
    browserTargets,
    definitionJson: JSON.stringify(definition),
  });
    audit(viewer.userId, viewer.organizationId, "test_created", { testId: created.id, name, browsers: browserTargets, version: 1 });
  recordMetric("studio.test_created", 1);
  return created;
}

export async function updateStudioTest(
  viewer: StudioViewer,
  id: string,
  input: Partial<SavedTestInput> & { status?: "DRAFT" | "ACTIVE" | "ARCHIVED"; expectedVersion?: number },
): Promise<SavedTestRow> {
  const existing = requireAccessibleTest(viewer, id);
  if (existing.status === "ARCHIVED") {
    throw new AppError("INVALID_INPUT", { message: "Archived tests are immutable. Duplicate the test to continue editing." });
  }
  // Optimistic concurrency: editors send the version they loaded; a mismatch
  // means someone else saved first — reject instead of silently clobbering.
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.current_version) {
    throw new AppError("CONFLICT", { message: `This test changed while you were editing (v${existing.current_version} is current). Reload and retry.` });
  }
  const fields: Parameters<typeof updateSavedTest>[1] = {};
  if (input.name !== undefined) fields.name = validateName(input.name);
  if (input.description !== undefined) fields.description = validateDescription(input.description);
  if (input.tags !== undefined) fields.tags = validateTags(input.tags);
  if (input.browserTargets !== undefined) {
    fields.browserTargets = validateBrowserTargets(input.browserTargets);
    assertBrowserEntitlement(viewer.userId, fields.browserTargets as BrowserId[]);
  }
  if (input.definition !== undefined) {
    let definition: SavedTestDefinition;
    try {
      definition = validateDefinition(input.definition);
    } catch (error) {
      if (error instanceof SavedTestValidationError) throw new AppError("INVALID_INPUT", { message: error.message });
      throw error;
    }
    const changed = definitionJson(definition) !== existing.definition_json;
    fields.definitionJson = definitionJson(definition);
    fields.bumpVersion = changed;
  }
  if (input.status !== undefined) {
    if (input.status === "ARCHIVED") fields.status = "ARCHIVED";
    else if (input.status === "ACTIVE") fields.status = "ACTIVE";
    else if (input.status === "DRAFT") fields.status = "DRAFT";
    else throw new AppError("INVALID_INPUT", { message: "Invalid test status." });
  }
  const updated = updateSavedTest(id, fields);
  if (!updated) throw new AppError("NOT_FOUND", { message: "Test not found." });
    audit(viewer.userId, viewer.organizationId, "test_updated", { testId: id, status: updated.status, version: updated.current_version, definitionChanged: fields.bumpVersion === true });
  return updated;
}

/** Duplicate = new identity at v1 with fresh history (§22: never clones runs). */
export async function duplicateStudioTest(viewer: StudioViewer, id: string): Promise<SavedTestRow> {
  const source = requireAccessibleTest(viewer, id);
  const { analysis, row } = await loadAndVerifyPackage(viewer, source.package_id);
  const copy = createSavedTest({
    organizationId: viewer.organizationId,
    userId: viewer.userId,
    extensionId: row.extension_id,
    packageId: source.package_id,
    packageSha256: row.sha256,
    packageVersion: analysis.metadata.version ?? row.version,
    name: `${source.name} (copy)`.slice(0, SAVED_TEST_LIMITS.maxNameLength),
    description: source.description,
    tags: JSON.parse(source.tags_json) as string[],
    browserTargets: JSON.parse(source.browser_targets_json) as BrowserId[],
    definitionJson: source.definition_json,
  });
    audit(viewer.userId, viewer.organizationId, "test_created", { testId: copy.id, duplicatedFrom: id, name: copy.name });
  return copy;
}

export function requireAccessibleTest(viewer: StudioViewer, id: string): SavedTestRow {
  const test = getAccessibleSavedTest({ userId: viewer.userId, organizationId: viewer.organizationId }, id);
  if (!test) throw new AppError("NOT_FOUND", { message: "Test not found." });
  return test;
}

function definitionJson(definition: SavedTestDefinition): string {
  return JSON.stringify(definition);
}

// ---------------------------------------------------------------------------
// Package binding
// ---------------------------------------------------------------------------

/**
 * Loads the package for a viewer (personal ownership or organization scope)
 * and re-analyzes it. The analysis gives extension name/version for
 * predefined variables; the sha anchors execution to the exact bytes.
 */
async function loadAndVerifyPackage(viewer: StudioViewer, packageId: string): Promise<{ analysis: ExtensionAnalysis; row: ExtensionPackageRow }> {
  const { bytes, row } = await readPackageBytesSafe(viewer, packageId);
  try {
    const analysis = await analyzeZipBytes(bytes, row.original_name ?? "package.zip");
    return { analysis, row };
  } catch {
    throw new AppError("INVALID_INPUT", { message: "The stored package could not be analyzed. Upload it again." });
  }
}

async function readPackageBytesSafe(viewer: StudioViewer, packageId: string): Promise<{ bytes: Uint8Array; row: ExtensionPackageRow }> {
  const result = await readPackageBytes(packageId);
  if (result.row.organization_id) {
    if (result.row.organization_id !== viewer.organizationId) throw new AppError("NOT_FOUND", { message: "Package not found." });
  } else if (result.row.user_id !== viewer.userId) {
    throw new AppError("NOT_FOUND", { message: "Package not found." });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RunStudioTestOptions {
  /** Exact version to run (default: current). Runs are bound to it forever. */
  version?: number;
  browserId?: BrowserId;
  testUrl?: string;
  variables?: Record<string, unknown>;
  /** CI-originated runs require ACTIVE tests; interactive may preview DRAFTs. */
  source: "interactive" | "ci";
  idempotencyKey?: string;
}

export async function prepareStudioTestRun(viewer: StudioViewer, id: string, options: RunStudioTestOptions): Promise<{
  prepared: PreparedSavedTest;
  row: SavedTestRow;
  analysis: ExtensionAnalysis;
  packageId: string;
}> {
  const test = requireAccessibleTest(viewer, id);
  if (test.status === "ARCHIVED") throw new AppError("INVALID_INPUT", { message: "Archived tests cannot run." });
  if (options.source === "ci" && test.status !== "ACTIVE") {
    throw new AppError("INVALID_INPUT", { message: "CI can only run ACTIVE tests." });
  }
  const version = options.version ?? test.current_version;
  const versionRow = version === test.current_version ? null : getSavedTestVersion(id, version);
  const definitionJsonToRun = versionRow ? versionRow.definition_json : test.definition_json;
  if (!definitionJsonToRun) throw new AppError("NOT_FOUND", { message: `Version v${version} not found.` });

  const browserId = (options.browserId ?? "chromium") as BrowserId;
  const targets = JSON.parse(test.browser_targets_json) as string[];
  if (!targets.includes(browserId)) {
    throw new AppError("INVALID_INPUT", { message: `This test targets ${targets.join(", ")} — ${browserId} was not selected for it.` });
  }
  if (browserId !== "chromium") {
    const entitlement = canUseCrossBrowser(viewer.userId);
    if (!entitlement.allowed) throw new AppError("FORBIDDEN", { message: entitlement.reason ?? "Cross-browser testing requires a plan upgrade." });
  }

  let definition: SavedTestDefinition;
  try {
    definition = validateDefinition(JSON.parse(definitionJsonToRun));
  } catch (error) {
    if (error instanceof SavedTestValidationError) throw new AppError("INVALID_INPUT", { message: `Saved definition failed validation: ${error.message}` });
    throw error;
  }

  const { analysis, row } = await loadAndVerifyPackage(viewer, test.package_id);
  // §16: execution binds to the exact package bytes. A re-uploaded package
  // with different content is a different test subject — refuse, never
  // silently substitute.
  if (row.sha256 !== test.package_sha256) {
    throw new AppError("CONFLICT", {
      message: "The package for this test has changed since it was saved (SHA-256 mismatch). Re-save the test against the new package to run it.",
    });
  }

  let resolved;
  try {
    resolved = resolveVariables(definition, {
      extensionName: analysis.metadata.name ?? row.original_name ?? "extension",
      browser: browserId,
      testUrl: options.testUrl ?? testConfig().DEFAULT_TEST_PAGE_URL,
      packageVersion: analysis.metadata.version ?? row.version ?? "unknown",
      provided: options.variables,
    });
  } catch (error) {
    if (error instanceof SavedTestValidationError) throw new AppError("INVALID_INPUT", { message: error.message });
    throw error;
  }

  const prepared: PreparedSavedTest = {
    testId: test.id,
    version,
    name: test.name,
    description: test.description,
    category: definition.category,
    severity: definition.severity,
    timeoutMs: definition.timeoutMs,
    setup: resolved.setup,
    actions: resolved.actions,
    cleanup: resolved.cleanup,
    assertions: resolved.assertions,
  };
  return { prepared, row: test, analysis, packageId: test.package_id };
}

/** Interactive (dashboard) run: fresh browser, exact package, queued job. */
export async function runStudioTest(viewer: StudioViewer, id: string, options: RunStudioTestOptions) {
  const { prepared, analysis, packageId } = await prepareStudioTestRun(viewer, id, options);
  ensureWorker();
  const created = createQueuedTestRun({
    userId: viewer.userId,
    packageId,
    analysis,
    extensionId: getSavedTestById(id)?.extension_id ?? null,
    testUrl: options.testUrl,
    organizationId: viewer.organizationId,
    browserId: options.browserId ?? "chromium",
    savedTest: prepared,
  });
    audit(viewer.userId, viewer.organizationId, "test_run_started", { testId: id, runId: created.runId, version: prepared.version, browser: options.browserId ?? "chromium", source: options.source });
  return created;
}

/** Matrix run of one saved test across its selected browsers (§55). */
export async function runStudioTestMatrix(viewer: StudioViewer, id: string, options: Omit<RunStudioTestOptions, "browserId"> & { browsers: BrowserId[] }) {
  const test = requireAccessibleTest(viewer, id);
  if (test.status === "ARCHIVED") throw new AppError("INVALID_INPUT", { message: "Archived tests cannot run." });
  const browsers = options.browsers;
  if (browsers.length === 0) throw new AppError("INVALID_INPUT", { message: "Select at least one browser." });
  const entitlement = canUseCrossBrowser(viewer.userId);
  if (browsers.some((browser) => browser !== "chromium") && !entitlement.allowed) {
    throw new AppError("FORBIDDEN", { message: entitlement.reason ?? "Cross-browser testing requires a plan upgrade." });
  }
  const maxBrowsers = getMaxBrowsersPerRun(viewer.userId);
  if (browsers.length > maxBrowsers) {
    throw new AppError("INVALID_INPUT", { message: `Your plan allows at most ${maxBrowsers} browsers per run.` });
  }
  const targets = JSON.parse(test.browser_targets_json) as string[];
  for (const browser of browsers) {
    if (!targets.includes(browser)) {
      throw new AppError("INVALID_INPUT", { message: `This test targets ${targets.join(", ")} — ${browser} was not selected for it.` });
    }
  }
  const runs: Awaited<ReturnType<typeof runStudioTest>>[] = [];
  for (const browser of browsers) {
    runs.push(await runStudioTest(viewer, id, { ...options, browserId: browser }));
  }
  return { runs, browsers };
}

function ensureWorker(): void {
  try {
    ensureEmbeddedWorker();
  } catch (error) {
    logger.warn("studio.worker_notify_failed", { errorCode: (error as { code?: string }).code });
  }
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

export interface StudioSuiteInput {
  name: string;
  description: string;
  failurePolicy: "stop" | "continue";
  /** Deterministic order (§24): array position is the execution order. */
  testIds: string[];
  /** Dependencies by test id: must reference earlier members only (§26). */
  dependencies?: Record<string, string[]>;
}

export function createStudioSuite(viewer: StudioViewer, input: StudioSuiteInput): SavedTestSuiteRow {
  const name = validateName(input.name);
  const description = validateDescription(input.description);
  if (input.failurePolicy !== "stop" && input.failurePolicy !== "continue") {
    throw new AppError("INVALID_INPUT", { message: "failurePolicy must be stop or continue." });
  }
  const members = validateSuiteMembers(viewer, input.testIds, input.dependencies ?? {});
  const suite = createSavedTestSuite({
    organizationId: viewer.organizationId,
    userId: viewer.userId,
    name,
    description,
    failurePolicy: input.failurePolicy,
  });
  setSavedTestSuiteItems(
    suite.id,
    members.map((member) => ({ testId: member.testId, dependsOn: member.dependsOn })),
  );
    audit(viewer.userId, viewer.organizationId, "test_created", { suiteId: suite.id, name, tests: members.length, failurePolicy: input.failurePolicy });
  return suite;
}

function validateSuiteMembers(
  viewer: StudioViewer,
  testIds: string[],
  dependencies: Record<string, string[]>,
): Array<{ testId: string; dependsOn: string[] }> {
  if (testIds.length === 0) throw new AppError("INVALID_INPUT", { message: "A suite needs at least one test." });
  if (testIds.length > SAVED_TEST_LIMITS.maxSuiteTests) {
    throw new AppError("INVALID_INPUT", { message: `Suites allow at most ${SAVED_TEST_LIMITS.maxSuiteTests} tests.` });
  }
  const seen = new Set<string>();
  const rows: SavedTestRow[] = [];
  for (const testId of testIds) {
    const test = requireAccessibleTest(viewer, testId);
    if (test.status === "ARCHIVED") throw new AppError("INVALID_INPUT", { message: `Test ${test.name} is archived and cannot join a suite.` });
    if (seen.has(testId)) throw new AppError("INVALID_INPUT", { message: "Each test can appear once in a suite." });
    seen.add(testId);
    rows.push(test);
  }
  // A suite executes as one run in one browser against one package: every
  // member must be authored against the exact same package SHA-256. This is
  // what makes per-member exact-package binding (§16) possible.
  const referenceSha = rows[0].package_sha256;
  for (const row of rows) {
    if (row.package_sha256 !== referenceSha) {
      throw new AppError("INVALID_INPUT", {
        message: `Suite members must target the same package version. "${row.name}" was saved against different package bytes.`,
      });
    }
  }
  // Dependencies must point backwards only — cycles are impossible by
  // construction and forward references are rejected.
  for (const [testId, dependsOn] of Object.entries(dependencies)) {
    const index = testIds.indexOf(testId);
    if (index === -1) throw new AppError("INVALID_INPUT", { message: "Dependencies must reference suite members." });
    if (!Array.isArray(dependsOn) || dependsOn.length > 4) {
      throw new AppError("INVALID_INPUT", { message: "At most 4 dependencies per test." });
    }
    for (const dependency of dependsOn) {
      const dependencyIndex = testIds.indexOf(dependency);
      if (dependencyIndex === -1) throw new AppError("INVALID_INPUT", { message: `Dependency ${dependency} is not part of this suite.` });
      if (dependencyIndex >= index) {
        throw new AppError("INVALID_INPUT", { message: "Dependencies must reference tests earlier in the suite (no cycles, no forward references)." });
      }
    }
  }
  return rows.map((row) => ({ testId: row.id, dependsOn: dependencies[row.id] ?? [] }));
}

export function listStudioSuites(viewer: StudioViewer): Array<SavedTestSuiteRow & { tests: number }> {
  return listSavedTestSuites({ userId: viewer.userId, organizationId: viewer.organizationId }).map((suite) => ({
    ...suite,
    tests: listSavedTestSuiteItems(suite.id).length,
  }));
}

export function describeStudioSuite(viewer: StudioViewer, id: string) {
  const suite = getAccessibleSavedTestSuite({ userId: viewer.userId, organizationId: viewer.organizationId }, id);
  if (!suite) throw new AppError("NOT_FOUND", { message: "Suite not found." });
  const items = listSavedTestSuiteItems(id).map((item) => {
    const test = getSavedTestById(item.test_id);
    return test
      ? {
          testId: test.id,
          position: item.position,
          name: test.name,
          status: test.status,
          version: test.current_version,
          browsers: JSON.parse(test.browser_targets_json) as string[],
          dependsOn: JSON.parse(item.depends_on_json) as string[],
        }
      : null;
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return { suite, tests: items };
}

/**
 * Runs a suite as ONE run with deterministic ordering, explicit dependencies
 * and the suite failure policy — all members in a single fresh browser, same
 * engine path as a standalone test. Members share one package (enforced at
 * suite-save time), so exact-package binding holds for every member.
 */
export async function runStudioSuite(
  viewer: StudioViewer,
  id: string,
  options: { browserId?: BrowserId; testUrl?: string; source: "interactive" | "ci" },
) {
  const suite = getAccessibleSavedTestSuite({ userId: viewer.userId, organizationId: viewer.organizationId }, id);
  if (!suite) throw new AppError("NOT_FOUND", { message: "Suite not found." });
  const items = listSavedTestSuiteItems(id);
  if (items.length === 0) throw new AppError("INVALID_INPUT", { message: "This suite has no tests." });
  const browserId = options.browserId ?? "chromium";

  const preparedMembers: PreparedSavedTestMember[] = [];
  let first: { test: SavedTestRow; prepared: PreparedSavedTest; analysis: ExtensionAnalysis; packageId: string } | null = null;
  for (const item of items) {
    const test = getSavedTestById(item.test_id);
    if (!test) throw new AppError("INVALID_INPUT", { message: "A suite member no longer exists." });
    if (test.status === "ARCHIVED") throw new AppError("INVALID_INPUT", { message: `Suite member "${test.name}" is archived.` });
    const preparedRun = await prepareStudioTestRun(viewer, item.test_id, { browserId, testUrl: options.testUrl, source: options.source });
    if (!first) first = { test, prepared: preparedRun.prepared, analysis: preparedRun.analysis, packageId: preparedRun.packageId };
    const dependsOn = JSON.parse(item.depends_on_json) as string[];
    preparedMembers.push({
      testId: preparedRun.prepared.testId,
      version: preparedRun.prepared.version,
      name: preparedRun.prepared.name,
      description: preparedRun.prepared.description,
      category: preparedRun.prepared.category,
      severity: preparedRun.prepared.severity,
      timeoutMs: preparedRun.prepared.timeoutMs,
      setup: preparedRun.prepared.setup,
      actions: preparedRun.prepared.actions,
      cleanup: preparedRun.prepared.cleanup,
      assertions: preparedRun.prepared.assertions,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    });
  }
  const anchor = first!;

  const prepared: PreparedSavedTest = {
    testId: suite.id,
    version: 1,
    name: suite.name,
    description: suite.description,
    category: preparedMembers[0].category,
    severity: preparedMembers[0].severity,
    timeoutMs: testConfig().MAX_TEST_RUN_TIME,
    setup: [],
    actions: [],
    cleanup: [],
    assertions: [],
    members: preparedMembers,
    failurePolicy: suite.failure_policy,
  };
  ensureWorker();
  const created = createQueuedTestRun({
    userId: viewer.userId,
    packageId: anchor.packageId,
    analysis: anchor.analysis,
    extensionId: anchor.test.extension_id,
    testUrl: options.testUrl,
    organizationId: viewer.organizationId,
    browserId,
    savedTest: prepared,
  });
    audit(viewer.userId, viewer.organizationId, "test_run_started", { suiteId: id, runId: created.runId, tests: preparedMembers.length, browser: browserId, source: options.source });
  return { ...created, members: preparedMembers.length };
}

// ---------------------------------------------------------------------------
// Listing / detail
// ---------------------------------------------------------------------------

export function listStudioTests(viewer: StudioViewer, filter: {
  page?: number;
  limit?: number;
  search?: string;
  status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  tag?: string;
  browserId?: string;
  suiteId?: string;
}): SavedTestListResult {
  return listSavedTests({ userId: viewer.userId, organizationId: viewer.organizationId }, {
    page: filter.page ?? 1,
    limit: filter.limit ?? 20,
    ...(filter.search ? { search: filter.search } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.tag ? { tag: filter.tag } : {}),
    ...(filter.browserId ? { browserId: filter.browserId } : {}),
    ...(filter.suiteId ? { suiteId: filter.suiteId } : {}),
  });
}

export function describeStudioTest(viewer: StudioViewer, id: string) {
  const test = requireAccessibleTest(viewer, id);
  return {
    test,
    definition: JSON.parse(test.definition_json) as SavedTestDefinition,
    versions: listSavedTestVersions(id).map((version) => ({ version: version.version, createdAt: version.created_at })),
    analytics: getSavedTestAnalytics(id),
  };
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export interface SavedTestExport {
  schemaVersion: typeof SAVED_TEST_SCHEMA_VERSION;
  kind: "extensionlab.saved-test";
  exportedAt: number;
  name: string;
  description: string;
  tags: string[];
  browsers: string[];
  definition: SavedTestDefinition;
}

/** Export NEVER includes secrets (none exist), runs or organization internals. */
export function exportStudioTest(viewer: StudioViewer, id: string): SavedTestExport {
  const test = requireAccessibleTest(viewer, id);
  return {
    schemaVersion: SAVED_TEST_SCHEMA_VERSION,
    kind: "extensionlab.saved-test",
    exportedAt: Date.now(),
    name: test.name,
    description: test.description,
    tags: JSON.parse(test.tags_json) as string[],
    browsers: JSON.parse(test.browser_targets_json) as string[],
    definition: JSON.parse(test.definition_json) as SavedTestDefinition,
  };
}

const MAX_IMPORT_BYTES = 256 * 1024;

/**
 * Import is untrusted input: bounded size, strict schema, unknown-field
 * rejection (inside validateDefinition), full re-validation, always saved as
 * a fresh DRAFT owned by the importer. Atomic — any error rejects the whole
 * file.
 */
export async function importStudioTest(viewer: StudioViewer, rawJson: string, packageId: string): Promise<SavedTestRow> {
  if (typeof rawJson !== "string" || rawJson.length === 0) throw new AppError("INVALID_INPUT", { message: "Empty import payload." });
  if (rawJson.length > MAX_IMPORT_BYTES) throw new AppError("INVALID_INPUT", { message: "Import files are limited to 256 KB." });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new AppError("INVALID_INPUT", { message: "The file is not valid JSON." });
  }
  if (typeof parsed !== "object" || parsed === null) throw new AppError("INVALID_INPUT", { message: "The import file must be a JSON object." });
  const record = parsed as Record<string, unknown>;
  if (record.kind !== "extensionlab.saved-test") throw new AppError("INVALID_INPUT", { message: "Not an ExtensionLab saved-test export." });
  if (record.schemaVersion !== SAVED_TEST_SCHEMA_VERSION) throw new AppError("INVALID_INPUT", { message: `Unsupported schemaVersion (expected ${SAVED_TEST_SCHEMA_VERSION}).` });
  const allowed = new Set(["schemaVersion", "kind", "exportedAt", "name", "description", "tags", "browsers", "definition"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new AppError("INVALID_INPUT", { message: `Unexpected field "${key}" in the import file.` });
  }
  return await createStudioTest(viewer, {
    name: typeof record.name === "string" ? record.name : "Imported test",
    description: typeof record.description === "string" ? record.description : "",
    tags: Array.isArray(record.tags) ? record.tags : [],
    browserTargets: Array.isArray(record.browsers) ? record.browsers : ["chromium"],
    definition: record.definition,
  }, packageId);
}

// ---------------------------------------------------------------------------
// Baselines (§47–§48)
// ---------------------------------------------------------------------------

/** Pins a finished run of this saved test as the regression baseline. */
export function saveRunAsBaseline(viewer: StudioViewer, testId: string, runId: string) {
  const test = requireAccessibleTest(viewer, testId);
  const run = getDb().prepare("SELECT * FROM test_runs WHERE id = ?").get(runId) as import("@/lib/db/schema/types").TestRunRow | undefined;
  if (!run) throw new AppError("NOT_FOUND", { message: "Run not found." });
  if (run.saved_test_id !== testId) throw new AppError("INVALID_INPUT", { message: "That run did not execute this saved test." });
  if (run.organization_id ? run.organization_id !== viewer.organizationId : run.user_id !== viewer.userId) {
    throw new AppError("NOT_FOUND", { message: "Run not found." });
  }
  const outcomeGuard = run.outcome;
  if (outcomeGuard === null || outcomeGuard === undefined || !["PASSED", "FAILED", "TIMEOUT", "WARNING", "ERROR", "INFRASTRUCTURE_ERROR"].includes(outcomeGuard)) {
    throw new AppError("INVALID_INPUT", { message: "Only finished runs can become a baseline." });
  }
  const summary = buildSavedTestRunSummary(run);
  const outcome = run.outcome as string;
  const baseline = setSavedTestBaseline({
    userId: viewer.userId,
    savedTestId: testId,
    runId,
    testVersion: run.saved_test_version ?? test.current_version,
    packageSha256: test.package_sha256,
    browserId: run.browser_id ?? "chromium",
    outcome,
    durationMs: summary.durationMs,
    summary,
  });
  audit(viewer.userId, viewer.organizationId, "baseline_created", { testId, runId, version: baseline.test_version });
  return baseline;
}

export function describeBaseline(viewer: StudioViewer, testId: string) {
  requireAccessibleTest(viewer, testId);
  return getSavedTestBaseline(viewer.userId, testId);
}

/** Deterministic comparison of a finished run against the stored baseline. */
export function compareRunToBaseline(viewer: StudioViewer, testId: string, runId: string) {
  const baseline = getSavedTestBaseline(viewer.userId, testId);
  if (!baseline) throw new AppError("NOT_FOUND", { message: "No baseline saved for this test yet." });
  const run = getDb().prepare("SELECT * FROM test_runs WHERE id = ?").get(runId) as import("@/lib/db/schema/types").TestRunRow | undefined;
  if (!run || run.saved_test_id !== testId) throw new AppError("NOT_FOUND", { message: "Run not found for this test." });
  if (run.outcome === null) throw new AppError("INVALID_INPUT", { message: "The run has not finished yet." });
  const current = buildSavedTestRunSummary(run);
  const comparison = compareSavedTestRuns(JSON.parse(baseline.summary_json) as SavedTestRunSummary, current);
  return {
    baseline: { runId: baseline.run_id, version: baseline.test_version, outcome: baseline.outcome, createdAt: baseline.created_at },
    current: { runId, outcome: run.outcome, durationMs: current.durationMs },
    comparison,
  };
}
