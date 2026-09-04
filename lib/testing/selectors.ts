import { testConfig } from "./config";

/**
 * Safe selector validation.
 *
 * Only simple CSS selectors designed for inspecting a controlled page are
 * accepted. Selectors are treated as untrusted text and are never used to
 * execute JavaScript. Test runtimes build DOM queries from these values with
 * escaping; no arbitrary code path accepts a selector as a script.
 */

function allowedSelector(selector: string): boolean {
  return (
    /^#[A-Za-z_][\w-]*$/.test(selector) ||
    /^\.[A-Za-z_][\w-]*$/.test(selector) ||
    /^[A-Za-z][\w-]*$/.test(selector) ||
    /^\[data-testid=["'][\w-]+["']\]$/.test(selector) ||
    /^[A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)*$/.test(selector)
  );
}

export function validateSelector(selector: unknown): { ok: boolean; reason?: string } {
  if (typeof selector !== "string" || selector.trim() === "") {
    return { ok: false, reason: "A selector is required." };
  }
  if (selector.length > testConfig().MAX_SELECTOR_LENGTH) {
    return { ok: false, reason: "The selector is too long." };
  }
  if (!allowedSelector(selector.trim())) {
    return {
      ok: false,
      reason:
        "Only safe CSS selectors such as #id, .class, tag, and [data-testid=\"...\"] are allowed.",
    };
  }
  return { ok: true };
}

export function normalizeSelector(selector: string): string {
  return selector.trim();
}
