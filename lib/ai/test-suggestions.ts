import "server-only";
import { validateSelector } from "@/lib/testing/selectors";
import { testConfig } from "@/lib/testing/config";
import { validateTestUrl } from "@/lib/runtime/urls";
import type { AssertionType, TestActionType, TestCategory, TestSeverity } from "@/lib/testing/types";
import { redactForAI } from "./redaction";
import { validateEvidence } from "./schema";
import type { AIContext, AISuggestedTest } from "./types";

/**
 * Server-side validation of AI-suggested tests.
 *
 * A suggestion is *data*: it is never executed by this module. Before it may
 * even be shown to the user it must satisfy the same rules the Phase 4 test
 * engine enforces (`isSafeAction` in the runner, selector allowlist, SSRF URL
 * policy, per-test limits). Anything else — unknown actions, raw JavaScript,
 * shell commands, CDP, file access, javascript:/data: URLs, private hosts,
 * oversized suites — is rejected with a user-visible reason.
 */

export const ALLOWED_ACTIONS: readonly TestActionType[] = [
  "open_url",
  "reload_page",
  "wait",
  "click",
  "type",
  "select",
  "scroll",
  "inspect_text",
  "inspect_element",
  "open_popup",
  "clear_console",
  "capture_screenshot",
];

export const ALLOWED_ASSERTIONS: readonly AssertionType[] = [
  "element_exists",
  "element_visible",
  "text_contains",
  "url_equals",
  "url_contains",
  "console_contains",
  "console_not_contains",
  "network_request_seen",
  "network_status_equals",
  "extension_loaded",
  "content_script_detected",
  "service_worker_detected",
  "popup_available",
  "runtime_error_none",
  "network_4xx_none",
  "network_5xx_none",
];

export const ALLOWED_CATEGORIES: readonly TestCategory[] = [
  "manifest",
  "loading",
  "page",
  "content_script",
  "popup",
  "background",
  "service_worker",
  "permissions",
  "console",
  "network",
  "storage",
  "performance",
  "security",
];

export const ALLOWED_SEVERITIES: readonly TestSeverity[] = ["info", "low", "medium", "high", "critical"];

const SELECTOR_ACTIONS: ReadonlySet<TestActionType> = new Set(["click", "type", "select", "scroll", "inspect_text", "inspect_element"]);
const SELECTOR_ASSERTIONS: ReadonlySet<AssertionType> = new Set(["element_exists", "element_visible", "text_contains"]);
const VALUE_ASSERTIONS: ReadonlySet<AssertionType> = new Set([
  "text_contains",
  "url_equals",
  "url_contains",
  "console_contains",
  "console_not_contains",
  "network_request_seen",
]);

const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const MAX_VALUE_LENGTH = 200;
const MAX_TEXT_LENGTH = 400;
const MAX_ASSERTIONS = 12;
/** Text that must never appear in any suggested value (defense in depth on top of the type allowlist). */
const DANGEROUS_VALUE = /(javascript:|data:text\/html|<script|\bexec\b|\bspawn\b|child_process|\bdocker\b|\bsudo\b|\brm\s+-rf|\bcurl\b|\bwget\b|\bfs\.\w+|process\.env|chrome\.debugger|Runtime\.evaluate|\beval\s*\()/i;

export type SuggestionVerdict = { ok: true; test: AISuggestedTest } | { ok: false; name: string; reason: string };

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = redactForAI(value.replace(/\s+/g, " ").trim());
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function reject(name: string, reason: string): SuggestionVerdict {
  return { ok: false, name, reason };
}

/** Same policy as the runner's `isSafeAction`, with explicit reasons. */
export function validateSuggestedStep(step: unknown): { ok: true; step: AISuggestedTest["steps"][number] } | { ok: false; reason: string } {
  if (!step || typeof step !== "object" || Array.isArray(step)) return { ok: false, reason: "A step was not an object." };
  const record = step as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string") return { ok: false, reason: "A step has no action type." };
  if (!ALLOWED_ACTIONS.includes(type as TestActionType)) return { ok: false, reason: `Action "${type.slice(0, 40)}" is not part of the test engine.` };
  // Unknown keys (e.g. "script", "command", "code") are a rejection, not a warning.
  const extra = Object.keys(record).filter((key) => !["type", "selector", "value", "milliseconds", "url"].includes(key));
  if (extra.length > 0) return { ok: false, reason: `Step contains unsupported fields: ${extra.slice(0, 3).join(", ")}.` };
  const action = type as TestActionType;
  const out: AISuggestedTest["steps"][number] = { type: action };
  const config = testConfig();

  if (record.selector !== undefined) {
    const verdict = validateSelector(record.selector);
    if (!verdict.ok) return { ok: false, reason: verdict.reason ?? "Unsafe selector." };
    out.selector = String(record.selector).trim();
  } else if (SELECTOR_ACTIONS.has(action)) {
    return { ok: false, reason: `Action "${action}" requires a selector.` };
  }

  if (record.value !== undefined) {
    if (typeof record.value !== "string") return { ok: false, reason: "Step value must be text." };
    if (record.value.length > MAX_VALUE_LENGTH) return { ok: false, reason: "Step value is too long." };
    if (DANGEROUS_VALUE.test(record.value)) return { ok: false, reason: "Step value contains executable or command-like content." };
    out.value = redactForAI(record.value);
  }
  if (action === "type" && out.value === undefined) return { ok: false, reason: "Action \"type\" requires a value." };

  if (record.milliseconds !== undefined) {
    if (typeof record.milliseconds !== "number" || !Number.isFinite(record.milliseconds) || record.milliseconds < 0) {
      return { ok: false, reason: "Wait duration must be a non-negative number." };
    }
    if (record.milliseconds > config.MAX_WAIT_MS) return { ok: false, reason: `Wait duration exceeds ${config.MAX_WAIT_MS} ms.` };
    out.milliseconds = Math.round(record.milliseconds);
  }
  if (action === "wait" && out.milliseconds === undefined) out.milliseconds = 500;

  if (action === "open_url") {
    if (typeof record.url !== "string") return { ok: false, reason: "open_url requires a URL." };
    const url = record.url.trim();
    if (url === config.DEFAULT_TEST_PAGE_URL) {
      out.url = url;
    } else {
      if (/^(javascript|data|file|chrome|chrome-extension|about|blob|ftp|vbscript):/i.test(url)) {
        return { ok: false, reason: "Only https URLs may be opened." };
      }
      const verdict = validateTestUrl(url);
      if (!verdict.ok || !verdict.url) return { ok: false, reason: verdict.reason ?? "This URL cannot be tested from the sandbox." };
      if (!verdict.url.startsWith("https://")) return { ok: false, reason: "Only https URLs may be opened." };
      out.url = verdict.url;
    }
  } else if (record.url !== undefined) {
    return { ok: false, reason: `Action "${action}" does not accept a URL.` };
  }
  return { ok: true, step: out };
}

export function validateSuggestedAssertion(assertion: unknown): { ok: true; assertion: AISuggestedTest["assertions"][number] } | { ok: false; reason: string } {
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) return { ok: false, reason: "An assertion was not an object." };
  const record = assertion as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string") return { ok: false, reason: "An assertion has no type." };
  if (!ALLOWED_ASSERTIONS.includes(type as AssertionType)) return { ok: false, reason: `Assertion "${type.slice(0, 40)}" is not part of the test engine.` };
  const extra = Object.keys(record).filter((key) => !["type", "selector", "value", "expectedStatus", "message"].includes(key));
  if (extra.length > 0) return { ok: false, reason: `Assertion contains unsupported fields: ${extra.slice(0, 3).join(", ")}.` };
  const kind = type as AssertionType;
  const out: AISuggestedTest["assertions"][number] = { type: kind };
  if (record.selector !== undefined) {
    const verdict = validateSelector(record.selector);
    if (!verdict.ok) return { ok: false, reason: verdict.reason ?? "Unsafe selector." };
    out.selector = String(record.selector).trim();
  } else if (SELECTOR_ASSERTIONS.has(kind) && kind !== "text_contains") {
    return { ok: false, reason: `Assertion "${kind}" requires a selector.` };
  }
  if (record.value !== undefined) {
    if (typeof record.value !== "string") return { ok: false, reason: "Assertion value must be text." };
    if (record.value.length > MAX_VALUE_LENGTH) return { ok: false, reason: "Assertion value is too long." };
    if (DANGEROUS_VALUE.test(record.value)) return { ok: false, reason: "Assertion value contains executable or command-like content." };
    out.value = redactForAI(record.value);
  } else if (VALUE_ASSERTIONS.has(kind)) {
    return { ok: false, reason: `Assertion "${kind}" requires a value.` };
  }
  if (record.expectedStatus !== undefined) {
    if (typeof record.expectedStatus !== "number" || !Number.isInteger(record.expectedStatus) || record.expectedStatus < 100 || record.expectedStatus > 599) {
      return { ok: false, reason: "expectedStatus must be an HTTP status code." };
    }
    out.expectedStatus = record.expectedStatus;
  } else if (kind === "network_status_equals") {
    return { ok: false, reason: "network_status_equals requires expectedStatus." };
  }
  const message = clean(record.message, MAX_TEXT_LENGTH);
  if (message) out.message = message;
  return { ok: true, assertion: out };
}

/** Validates one suggested test end to end. Never throws for bad input; returns a reason instead. */
export function validateSuggestedTest(candidate: Record<string, unknown>, context: AIContext): SuggestionVerdict {
  const config = testConfig();
  const name = clean(candidate.name, 120) ?? "Unnamed suggestion";
  const id = typeof candidate.id === "string" ? candidate.id.trim().toLowerCase() : "";
  if (!ID_PATTERN.test(id)) return reject(name, "Test id must be a short kebab-case identifier.");
  if (!ALLOWED_CATEGORIES.includes(candidate.category as TestCategory)) return reject(name, "Unknown test category.");
  if (!ALLOWED_SEVERITIES.includes(candidate.severity as TestSeverity)) return reject(name, "Unknown severity.");
  const description = clean(candidate.description, MAX_TEXT_LENGTH);
  if (!description) return reject(name, "A description is required.");
  const rationale = clean(candidate.rationale, MAX_TEXT_LENGTH) ?? "";
  const timeoutRaw = candidate.timeout;
  const timeout = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) ? Math.round(timeoutRaw) : config.TEST_TIMEOUT;
  if (timeout < 1000 || timeout > config.TEST_TIMEOUT) return reject(name, `Timeout must be between 1000 and ${config.TEST_TIMEOUT} ms.`);

  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) return reject(name, "At least one step is required.");
  if (candidate.steps.length > config.MAX_ACTIONS_PER_TEST) return reject(name, `A test may have at most ${config.MAX_ACTIONS_PER_TEST} steps.`);
  const steps: AISuggestedTest["steps"] = [];
  for (const step of candidate.steps) {
    const verdict = validateSuggestedStep(step);
    if (!verdict.ok) return reject(name, verdict.reason);
    steps.push(verdict.step);
  }
  const totalWait = steps.reduce((sum, step) => sum + (step.milliseconds ?? 0), 0);
  if (totalWait > timeout) return reject(name, "The combined wait time exceeds the test timeout.");

  if (!Array.isArray(candidate.assertions) || candidate.assertions.length === 0) return reject(name, "At least one assertion is required.");
  if (candidate.assertions.length > MAX_ASSERTIONS) return reject(name, `A test may have at most ${MAX_ASSERTIONS} assertions.`);
  const assertions: AISuggestedTest["assertions"] = [];
  for (const assertion of candidate.assertions) {
    const verdict = validateSuggestedAssertion(assertion);
    if (!verdict.ok) return reject(name, verdict.reason);
    assertions.push(verdict.assertion);
  }

  const allowedKeys = ["id", "name", "description", "category", "severity", "timeout", "steps", "assertions", "rationale", "evidence"];
  const extra = Object.keys(candidate).filter((key) => !allowedKeys.includes(key));
  if (extra.length > 0) return reject(name, `Unsupported fields: ${extra.slice(0, 3).join(", ")}.`);

  return {
    ok: true,
    test: {
      id,
      name,
      description,
      category: candidate.category as TestCategory,
      severity: candidate.severity as TestSeverity,
      timeout,
      steps,
      assertions,
      rationale,
      evidence: validateEvidence(candidate.evidence, context, "$.tests"),
    },
  };
}

export function maxSuggestedTests(): number {
  return Math.min(8, testConfig().MAX_TESTS_PER_RUN);
}
