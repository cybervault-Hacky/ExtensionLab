import { testConfig } from "./config";
import { validateSelector } from "./selectors";
import type {
  AssertionContext,
  AssertionOutcome,
  TestAssertion,
} from "./types";

/**
 * Deterministic assertion engine.
 *
 * Every assertion is evaluated against evidence that was actually observed in
 * the sandbox/runner (or against deterministic static analysis). There is no
 * path that fabricates a pass.
 */

export function evaluateAssertion(
  assertion: TestAssertion,
  context: AssertionContext,
): AssertionOutcome {
  switch (assertion.type) {
    case "element_exists":
      return requireElement(assertion, context, false);
    case "element_visible":
      return requireElement(assertion, context, true);
    case "text_contains": {
      const selector = assertion.selector;
      if (selector && validateSelector(selector).ok === false) {
        return fail(assertion, "Selector is not allowed.");
      }
      const field = selector
        ? context.currentElement?.text
        : context.currentTextInspection;
      const value = assertion.value ?? "";
      if (typeof field === "string" && field.includes(value)) {
        return pass(assertion, `Found "${value}".`);
      }
      return fail(assertion, `Expected text containing "${value}" was not found.`);
    }
    case "url_equals":
      return context.url === assertion.value
        ? pass(assertion, `URL equals ${assertion.value}.`)
        : fail(
            assertion,
            `Expected ${assertion.value}, observed ${context.url ?? "no URL"}.`,
          );
    case "url_contains":
      return typeof context.url === "string" && context.url.includes(assertion.value ?? "")
        ? pass(assertion, `URL contains ${assertion.value}.`)
        : fail(assertion, `URL did not contain ${assertion.value}.`);
    case "console_contains":
      return hasConsoleMatching(context, assertion.value ?? "", false);
    case "console_not_contains":
      return hasConsoleMatching(context, assertion.value ?? "", true);
    case "network_request_seen":
      return hasNetworkMatching(context, { urlContains: assertion.value ?? "" });
    case "network_status_equals":
      return hasNetworkStatus(context, assertion.expectedStatus);
    case "extension_loaded":
      return context.extensionLoaded
        ? pass(assertion, "Extension loaded successfully.")
        : fail(assertion, "Extension could not be loaded.");
    case "content_script_detected":
      return context.contentScriptDetected
        ? pass(assertion, "Content script evidence was observed.")
        : fail(assertion, "No content-script evidence was observed.");
    case "service_worker_detected":
      return context.serviceWorkerDetected
        ? pass(assertion, "Service worker evidence was observed.")
        : fail(assertion, "No service-worker evidence was observed.");
    case "popup_available":
      return context.popupAvailable
        ? pass(assertion, "Popup is available.")
        : fail(assertion, "Popup is not available in this environment.");
    case "runtime_error_none": {
      const errors = context.consoleEvents.filter(
        (event) => (event.type === "error" || event.level === "error") && event.level !== "info",
      );
      return errors.length === 0
        ? pass(assertion, "No runtime errors were captured.")
        : fail(assertion, `${errors.length} runtime error(s) were captured.`);
    }
    case "network_4xx_none":
      return has4xxOr5xx(context, false, assertion);
    case "network_5xx_none":
      return has4xxOr5xx(context, true, assertion);
    default:
      return fail(assertion, "Unknown assertion.");
  }
}

function requireElement(
  assertion: TestAssertion,
  context: AssertionContext,
  requireVisible: boolean,
): AssertionOutcome {
  const selector = assertion.selector;
  if (!selector) return fail(assertion, "A selector is required.");
  const validation = validateSelector(selector);
  if (!validation.ok) return fail(assertion, validation.reason ?? "Invalid selector.");

  const inspectedSelector = context.currentElementSelector;
  if (inspectedSelector && inspectedSelector !== selector) {
    return fail(assertion, `Expected element "${selector}" was not found.`);
  }
  const element = context.currentElement;
  if (!element || !element.exists) {
    return fail(assertion, `Expected element "${selector}" was not found.`);
  }
  if (requireVisible && !element.visible) {
    return fail(assertion, `Element "${selector}" exists but is not visible.`);
  }
  return pass(
    assertion,
    requireVisible
      ? `Element "${selector}" exists and is visible.`
      : `Element "${selector}" exists.`,
  );
}

function hasConsoleMatching(
  context: AssertionContext,
  needle: string,
  negate: boolean,
): AssertionOutcome {
  const present = context.consoleEvents.some(
    (event) => event.message.includes(needle) || event.source.includes(needle),
  );
  if (negate) {
    return present
      ? fail(assertionMessage(`Console unexpectedly contained "${needle}".`), "")
      : pass(assertionMessage(`Console did not contain "${needle}".`), "");
  }
  return present
    ? pass(assertionMessage(`Console contains "${needle}".`), "")
    : fail(assertionMessage(`Console did not contain "${needle}".`), "");
}

function hasNetworkMatching(
  context: AssertionContext,
  options: { urlContains: string },
): AssertionOutcome {
  const present = context.networkEntries.some((entry) =>
    entry.url.includes(options.urlContains),
  );
  return present
    ? pass({ type: "network_request_seen" }, `Network request matching "${options.urlContains}" was observed.`)
    : fail({ type: "network_request_seen" }, `No network request matching "${options.urlContains}" was observed.`);
}

function hasNetworkStatus(
  context: AssertionContext,
  expected?: number,
): AssertionOutcome {
  if (typeof expected !== "number") return fail({ type: "network_status_equals" }, "No expected status provided.");
  const matched = context.networkEntries.some((entry) => entry.status === expected);
  return matched
    ? pass({ type: "network_status_equals" }, `Network request with status ${expected} was observed.`)
    : fail({ type: "network_status_equals" }, `No request with status ${expected} was observed.`);
}

function has4xxOr5xx(
  context: AssertionContext,
  mode500: boolean,
  assertion: TestAssertion,
): AssertionOutcome {
  const bad = context.networkEntries.filter((entry) => {
    if (entry.status === null) return false;
    return mode500 ? entry.status >= 500 : entry.status >= 400 && entry.status < 500;
  });
  return bad.length === 0
    ? pass(assertion, `No ${mode500 ? "5xx" : "4xx"} responses observed.`)
    : fail(assertion, `${bad.length} ${mode500 ? "5xx" : "4xx"} response(s) observed.`);
}

function pass(assertion: TestAssertion, message: string): AssertionOutcome {
  return { assertion, passed: true, message };
}
function fail(assertion: TestAssertion, message: string): AssertionOutcome {
  return { assertion, passed: false, message };
}
function assertionMessage(_message: string): TestAssertion {
  return { type: "console_contains" };
}
