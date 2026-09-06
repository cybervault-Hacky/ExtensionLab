import "server-only";
import { testConfig } from "./config";
import { validateSelector } from "./selectors";
import type { AssertionType, TestAction, TestActionType, TestAssertion, TestCategory, TestSeverity } from "./types";

/**
 * Phase 15 saved-test definition schema (versioned, validated, safe).
 *
 * A saved test is plain data: allowlisted actions + assertions from the
 * Phase 4 engine, bounded variables, and metadata. Everything is validated
 * here — at save time AND again at execution time — so nothing executable
 * (JS, shell, CDP, browser flags) can ever enter a definition. Import JSON
 * is untrusted input through the same validator.
 */

export const SAVED_TEST_SCHEMA_VERSION = 1 as const;

/** Centralized limits (§101): no scattered magic numbers. */
export const SAVED_TEST_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  maxSteps: 50,
  maxSetupSteps: 10,
  maxCleanupSteps: 10,
  maxAssertions: 30,
  maxVariables: 10,
  maxTags: 6,
  maxTagLength: 32,
  maxVariableNameLength: 64,
  maxTextValueLength: 2000,
  maxSelectorLength: 200,
  minTimeoutMs: 1000,
  maxTimeoutMs: 120_000,
  maxDefinitionBytes: 128 * 1024,
  maxBrowsersPerTest: 3,
  maxSuiteTests: 10,
} as const;

/** Actions that take a selector. Drives the step editor's fields (§8). */
export const SELECTOR_ACTIONS: ReadonlySet<TestActionType> = new Set(["click", "type", "select", "scroll", "inspect_text", "inspect_element"]);
/** Actions that take a free-text value. */
export const VALUE_ACTIONS: ReadonlySet<TestActionType> = new Set(["type", "select", "inspect_text"]);
/** Actions that take a URL. */
export const URL_ACTIONS: ReadonlySet<TestActionType> = new Set(["open_url"]);

/** The exact Phase 4 engine allowlist (§15: no additions, ever). */
export const ALLOWED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "open_url", "reload_page", "wait", "click", "type", "select", "scroll",
  "inspect_text", "inspect_element", "open_popup", "clear_console", "capture_screenshot",
]);

/** The exact Phase 4 assertion allowlist (mirrors AssertionType). */
export const ALLOWED_ASSERTION_TYPES: ReadonlySet<string> = new Set([
  "element_exists", "element_visible", "text_contains", "url_equals", "url_contains",
  "console_contains", "console_not_contains", "network_request_seen", "network_status_equals",
  "extension_loaded", "content_script_detected", "service_worker_detected", "popup_available",
  "runtime_error_none", "network_4xx_none", "network_5xx_none",
]);

export type VariableType = "text" | "number" | "url" | "boolean";

export interface SavedTestVariable {
  name: string;
  type: VariableType;
  required?: boolean;
  maxLength?: number;
  defaultValue?: string;
  description?: string;
}

export interface SavedTestStep extends TestAction {
  /** Free-form, bounded note shown in the builder (never executed). */
  description?: string;
}

export interface SavedTestDefinition {
  schemaVersion: typeof SAVED_TEST_SCHEMA_VERSION;
  setup: SavedTestStep[];
  actions: SavedTestStep[];
  assertions: TestAssertion[];
  cleanup: SavedTestStep[];
  variables: SavedTestVariable[];
  timeoutMs: number;
  category: TestCategory;
  severity: TestSeverity;
}

/** Predefined variables resolved by the server (§12) — never user-defined JS. */
export const PREDEFINED_VARIABLES = ["extension_name", "browser", "test_url", "package_version"] as const;
export type PredefinedVariable = (typeof PREDEFINED_VARIABLES)[number];

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "manifest", "loading", "page", "content_script", "popup", "background", "service_worker",
  "permissions", "console", "network", "storage", "performance", "security",
]);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(["info", "low", "medium", "high", "critical"]);

export class SavedTestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedTestValidationError";
  }
}

function fail(message: string): never {
  throw new SavedTestValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateVariableName(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) fail(`Variable name "${name.slice(0, 40)}" is invalid (lowercase letters, digits, underscore).`);
  if ((PREDEFINED_VARIABLES as readonly string[]).includes(name)) fail(`Variable name "${name}" is reserved.`);
}

function validateVariables(raw: unknown): SavedTestVariable[] {
  if (!Array.isArray(raw)) fail("variables must be an array.");
  if (raw.length > SAVED_TEST_LIMITS.maxVariables) fail(`At most ${SAVED_TEST_LIMITS.maxVariables} variables are allowed.`);
  const seen = new Set<string>();
  const variables: SavedTestVariable[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) fail("Each variable must be an object.");
    const name = typeof item.name === "string" ? item.name : fail("Variable name is required.");
    validateVariableName(name);
    if (seen.has(name)) fail(`Duplicate variable "${name}".`);
    seen.add(name);
    const type = item.type;
    if (type !== "text" && type !== "number" && type !== "url" && type !== "boolean") fail(`Variable "${name}" has an unsupported type.`);
    const maxLength =
      type === "text" && typeof item.maxLength === "number"
        ? Math.min(Math.max(Math.round(item.maxLength), 1), SAVED_TEST_LIMITS.maxTextValueLength)
        : undefined;
    if (type === "text" && item.maxLength !== undefined && (typeof item.maxLength !== "number" || item.maxLength < 1 || item.maxLength > SAVED_TEST_LIMITS.maxTextValueLength)) {
      fail(`Variable "${name}" maxLength must be between 1 and ${SAVED_TEST_LIMITS.maxTextValueLength}.`);
    }
    let defaultValue: string | undefined;
    if (item.defaultValue !== undefined) {
      if (typeof item.defaultValue !== "string") fail(`Variable "${name}" default must be a string.`);
      if (item.defaultValue.length > SAVED_TEST_LIMITS.maxTextValueLength) fail(`Variable "${name}" default is too long.`);
      defaultValue = item.defaultValue;
    }
    const description = typeof item.description === "string" && item.description.trim() !== "" ? item.description.slice(0, 200) : undefined;
    variables.push({ name, type, ...(maxLength !== undefined ? { maxLength } : {}), ...(defaultValue !== undefined ? { defaultValue } : {}), ...(item.required === true ? { required: true } : {}), ...(description ? { description } : {}) });
  }
  return variables;
}

function validateStepAction(step: unknown, kind: "setup" | "action" | "cleanup", variableNames: ReadonlySet<string>): SavedTestStep {
  if (!isPlainObject(step)) fail(`Each ${kind} step must be an object.`);
  const type = step.type;
  if (typeof type !== "string") fail("Step type is required.");
  if (!ALLOWED_ACTION_TYPES.has(type)) fail(`Action "${type.slice(0, 40)}" is not in the allowlist.`);
  const out: SavedTestStep = { type: type as TestActionType };
  if (SELECTOR_ACTIONS.has(type as TestActionType)) {
    if (typeof step.selector !== "string") fail(`Step ${type} requires a selector.`);
    const verdict = validateSelector(step.selector);
    if (!verdict.ok) fail(`Step ${type}: ${verdict.reason}`);
    out.selector = step.selector.trim().slice(0, SAVED_TEST_LIMITS.maxSelectorLength);
  }
  if (VALUE_ACTIONS.has(type as TestActionType)) {
    if (typeof step.value !== "string" || step.value.length === 0) fail(`Step ${type} requires a value.`);
    if (step.value.length > SAVED_TEST_LIMITS.maxTextValueLength) fail(`Step ${type}: the value is too long.`);
    checkVariableReferences(step.value, variableNames, `Step ${type}`);
    out.value = step.value;
  }
  if (URL_ACTIONS.has(type as TestActionType)) {
    if (typeof step.url !== "string") fail("Step open_url requires a url.");
    if (step.url.length > 2048) fail("Step open_url: the URL is too long.");
    checkVariableReferences(step.url, variableNames, "Step open_url");
    out.url = step.url;
  }
  if (type === "wait") {
    const ms = step.milliseconds;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > 5000) fail("Step wait: milliseconds must be between 0 and 5000.");
    out.milliseconds = Math.round(ms);
  }
  if (typeof step.description === "string" && step.description.trim() !== "") {
    out.description = step.description.slice(0, 200);
  }
  // Unknown fields on steps are rejected (strict import validation, §82).
  const allowed = new Set(["type", "selector", "value", "milliseconds", "url", "description"]);
  for (const key of Object.keys(step)) {
    if (!allowed.has(key)) fail(`Unexpected field "${key}" on a ${kind} step.`);
  }
  return out;
}

/** Finds {{references}} and rejects unknown variables. No evaluation, ever. */
export function checkVariableReferences(text: string, variableNames: ReadonlySet<string>, where = "Definition"): void {
  const references = text.match(/\{\{\s*([a-z0-9_]+)\s*\}\}/g) ?? [];
  for (const reference of references) {
    const name = reference.replace(/[{}\s]/g, "");
    if (!variableNames.has(name)) fail(`${where} references unknown variable "{{${name}}}".`);
  }
}

export function validateDefinition(raw: unknown): SavedTestDefinition {
  if (!isPlainObject(raw)) fail("The test definition must be an object.");
  if (raw.schemaVersion !== SAVED_TEST_SCHEMA_VERSION) fail(`Unsupported schemaVersion (expected ${SAVED_TEST_SCHEMA_VERSION}).`);
  if (JSON.stringify(raw).length > SAVED_TEST_LIMITS.maxDefinitionBytes) fail("The test definition is too large.");
  const variables = validateVariables(raw.variables ?? []);
  const variableNames = new Set<string>([...PREDEFINED_VARIABLES, ...variables.map((variable) => variable.name)]);

  const validateSteps = (value: unknown, kind: "setup" | "action" | "cleanup", max: number): SavedTestStep[] => {
    if (!Array.isArray(value)) fail(`${kind} must be an array.`);
    if (value.length > max) fail(`${kind} allows at most ${max} steps.`);
    return value.map((step) => validateStepAction(step, kind, variableNames));
  };
  const setup = validateSteps(raw.setup ?? [], "setup", SAVED_TEST_LIMITS.maxSetupSteps);
  const actions = validateSteps(raw.actions ?? [], "action", SAVED_TEST_LIMITS.maxSteps);
  const cleanup = validateSteps(raw.cleanup ?? [], "cleanup", SAVED_TEST_LIMITS.maxCleanupSteps);
  if (actions.length === 0 && setup.length === 0) fail("A test needs at least one step.");

  if (!Array.isArray(raw.assertions)) fail("assertions must be an array.");
  if (raw.assertions.length > SAVED_TEST_LIMITS.maxAssertions) fail(`At most ${SAVED_TEST_LIMITS.maxAssertions} assertions are allowed.`);
  const assertions: TestAssertion[] = raw.assertions.map((entry: unknown) => {
    if (!isPlainObject(entry)) fail("Each assertion must be an object.");
    const type = entry.type;
    if (typeof type !== "string") fail("Assertion type is required.");
    if (!ALLOWED_ASSERTION_TYPES.has(type)) fail(`Assertion "${type.slice(0, 40)}" is not in the allowlist.`);
    const out: TestAssertion = { type: type as AssertionType };
    if (typeof entry.selector === "string") {
      const verdict = validateSelector(entry.selector);
      if (!verdict.ok) fail(`Assertion ${type}: ${verdict.reason}`);
      out.selector = entry.selector.trim();
    }
    if (typeof entry.value === "string") {
      if (entry.value.length > SAVED_TEST_LIMITS.maxTextValueLength) fail(`Assertion ${type}: the value is too long.`);
      checkVariableReferences(entry.value, variableNames, `Assertion ${type}`);
      out.value = entry.value;
    }
    if (entry.expectedStatus !== undefined) {
      if (typeof entry.expectedStatus !== "number" || !Number.isInteger(entry.expectedStatus) || entry.expectedStatus < 100 || entry.expectedStatus > 599) {
        fail("Assertion expectedStatus must be an HTTP status code.");
      }
      out.expectedStatus = entry.expectedStatus;
    }
    if (typeof entry.message === "string" && entry.message.trim() !== "") out.message = entry.message.slice(0, 300);
    const allowed = new Set(["type", "selector", "value", "expectedStatus", "message"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) fail(`Unexpected field "${key}" on an assertion.`);
    }
    return out;
  });

  const timeoutMs = raw.timeoutMs ?? testConfig().TEST_TIMEOUT;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < SAVED_TEST_LIMITS.minTimeoutMs || timeoutMs > SAVED_TEST_LIMITS.maxTimeoutMs) {
    fail(`timeoutMs must be between ${SAVED_TEST_LIMITS.minTimeoutMs} and ${SAVED_TEST_LIMITS.maxTimeoutMs}.`);
  }
  const category = typeof raw.category === "string" && VALID_CATEGORIES.has(raw.category) ? (raw.category as TestCategory) : fail("Invalid test category.");
  const severity = typeof raw.severity === "string" && VALID_SEVERITIES.has(raw.severity) ? (raw.severity as TestSeverity) : fail("Invalid test severity.");

  // Unknown top-level fields are rejected (strict import validation).
  const allowedTop = new Set(["schemaVersion", "setup", "actions", "assertions", "cleanup", "variables", "timeoutMs", "category", "severity"]);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) fail(`Unexpected field "${key}" in the test definition.`);
  }

  return { schemaVersion: SAVED_TEST_SCHEMA_VERSION, setup, actions, assertions, cleanup, variables, timeoutMs: Math.round(timeoutMs), category, severity };
}

export function validateTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > SAVED_TEST_LIMITS.maxTags) fail(`At most ${SAVED_TEST_LIMITS.maxTags} tags are allowed.`);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== "string" || !/^[a-z0-9-]{1,32}$/.test(tag)) fail(`Tag "${String(tag).slice(0, 32)}" is invalid (lowercase, digits, hyphens).`);
    if (seen.has(tag)) fail(`Duplicate tag "${tag}".`);
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/**
 * Resolves {{variables}} into concrete values with strict typing. Pure string
 * substitution after validation — never evaluated as code. Runtime values
 * come from the server (predefined) or the (authenticated) request body and
 * are type-checked per variable definition.
 */
export interface VariableResolutionContext {
  extensionName: string;
  browser: string;
  testUrl: string;
  packageVersion: string;
  /** Caller-supplied values for user-defined variables. */
  provided?: Record<string, unknown>;
}

export function resolveVariables(
  definition: SavedTestDefinition,
  context: VariableResolutionContext,
): { setup: TestAction[]; actions: TestAction[]; cleanup: TestAction[]; assertions: TestAssertion[] } {
  const values = new Map<string, string>();
  values.set("extension_name", context.extensionName.slice(0, 200));
  values.set("browser", context.browser.slice(0, 40));
  values.set("test_url", context.testUrl.slice(0, 2048));
  values.set("package_version", context.packageVersion.slice(0, 40));

  for (const variable of definition.variables) {
    const raw = context.provided?.[variable.name] ?? variable.defaultValue;
    if (raw === undefined || raw === null || raw === "") {
      if (variable.required) fail(`Variable "${variable.name}" is required.`);
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") fail(`Variable "${variable.name}" must be a scalar.`);
    const asText = String(raw);
    if (asText.length > (variable.maxLength ?? SAVED_TEST_LIMITS.maxTextValueLength)) fail(`Variable "${variable.name}" exceeds its maximum length.`);
    if (variable.type === "number" && !/^-?\d+(\.\d+)?$/.test(asText)) fail(`Variable "${variable.name}" must be a number.`);
    if (variable.type === "boolean" && !/^(true|false)$/.test(asText)) fail(`Variable "${variable.name}" must be true or false.`);
    if (variable.type === "url") {
      try {
        const parsed = new URL(asText);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
      } catch {
        fail(`Variable "${variable.name}" must be a valid http(s) URL.`);
      }
    }
    values.set(variable.name, asText);
  }

  const substitute = (text: string): string =>
    text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_match, name: string) => values.get(name) ?? fail(`Unknown variable "{{${name}}}".`));

  const mapStep = (step: SavedTestStep): TestAction => {
    const out: TestAction = { type: step.type };
    if (step.selector !== undefined) out.selector = step.selector;
    if (step.value !== undefined) out.value = substitute(step.value);
    if (step.url !== undefined) out.url = substitute(step.url);
    if (step.milliseconds !== undefined) out.milliseconds = step.milliseconds;
    return out;
  };
  const mapAssertion = (assertion: TestAssertion): TestAssertion => {
    const out: TestAssertion = { ...assertion };
    if (assertion.value !== undefined) out.value = substitute(assertion.value);
    return out;
  };

  return {
    setup: definition.setup.map(mapStep),
    actions: definition.actions.map(mapStep),
    cleanup: definition.cleanup.map(mapStep),
    assertions: definition.assertions.map(mapAssertion),
  };
}

void testConfig;
