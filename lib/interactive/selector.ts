import "server-only";
import { validateSelector } from "@/lib/testing/selectors";

/**
 * Phase 12 deterministic selector suggestion.
 *
 * Given the bounded element metadata from the fixed in-container inspection
 * script, propose ONE selector using a fixed preference order. The result is
 * always validated against the Phase 4 selector grammar; when nothing safe is
 * derivable the answer is null — never a huge, dynamic, or unsafe selector.
 *
 * Preference order:
 *   1. [data-testid="..."]      — the stable, purpose-built hook
 *   2. #id                       — stable when present
 *   3. .class                    — first STABLE class (no css-module hashes,
 *                                  no digit-heavy framework classes)
 *   4. tag                       — bare tag name
 * Dynamic/framework-generated classes (css-1q2w3e, jsx-42, _abc123,
 * Button__root__3x2K1 style hashes) are skipped by a fixed heuristic.
 */

const MAX_CLASSES_CONSIDERED = 5;
const STABLE_CLASS = /^[A-Za-z][A-Za-z-]*[A-Za-z]$|^[A-Za-z]$/;
const CLASS_HASHY = /[0-9_]|_{2,}|__[A-Za-z0-9]*[0-9]|--/;

export interface SelectorCandidateElement {
  tag: string | null;
  id: string | null;
  classes: string[];
  attributes: Array<{ name: string; value: string }>;
}

function testIdFrom(attributes: Array<{ name: string; value: string }>): string | null {
  for (const attribute of attributes) {
    if (attribute.name === "data-testid" && attribute.value.trim()) return attribute.value.trim();
  }
  return null;
}

function firstStableClass(classes: string[]): string | null {
  for (const className of classes.slice(0, MAX_CLASSES_CONSIDERED)) {
    const trimmed = className.trim();
    if (!trimmed || trimmed.length > 60) continue;
    if (!STABLE_CLASS.test(trimmed)) continue;
    if (CLASS_HASHY.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/** Proposes a safe selector, or null when none can be derived safely. */
export function suggestSelector(element: SelectorCandidateElement): string | null {
  const candidates: string[] = [];

  const testId = testIdFrom(element.attributes ?? []);
  if (testId) candidates.push(`[data-testid="${testId.slice(0, 60)}"]`);

  if (element.id && element.id.trim()) candidates.push(`#${element.id.trim()}`);

  const stableClass = firstStableClass(element.classes ?? []);
  if (stableClass) candidates.push(`.${stableClass}`);

  if (element.tag && element.tag.trim()) candidates.push(element.tag.trim());

  for (const candidate of candidates) {
    if (candidate.length > 200) continue;
    const validation = validateSelector(candidate);
    if (validation.ok) return candidate;
  }
  return null;
}
