import "server-only";
import { createTestCase } from "./test-case";
import { createTestSuite } from "./test-suite";
import type { TestCase, TestSuite } from "./types";

/**
 * Phase 9 reusable test templates.
 *
 * Templates compose exclusively from the existing safe action/assertion
 * allowlist (lib/testing/types.ts) — no new browser capabilities are added and
 * no arbitrary scripts, selectors or flags can enter through a template.
 * `advanced: true` templates require the advancedSuites entitlement.
 */

export interface TestTemplate {
  id: string;
  suiteId: string;
  name: string;
  description: string;
  advanced: boolean;
  build: () => TestSuite;
}

const TEST_PAGE = "http://127.0.0.1:8080/extensionlab-test";

const popupSmokeSuite = (): TestSuite =>
  createTestSuite({
    id: "popup-smoke",
    name: "Popup Smoke Test",
    description: "Extension loads, the popup is available and opens, and basic UI exists.",
    tests: [
      createTestCase({
        id: "popup-smoke-loads",
        name: "Extension loads",
        description: "The extension loads in the isolated browser.",
        category: "loading",
        severity: "high",
        timeout: 10_000,
        steps: [
          { type: "open_url", url: TEST_PAGE },
          { type: "wait", milliseconds: 1000 },
        ],
        assertions: [{ type: "extension_loaded" }],
        applicable: () => true,
      }),
      createTestCase({
        id: "popup-smoke-open",
        name: "Popup opens",
        description: "The declared popup can be opened and exposes basic UI.",
        category: "popup",
        severity: "medium",
        timeout: 8_000,
        dependsOn: ["popup-smoke-loads"],
        steps: [{ type: "open_popup" }, { type: "wait", milliseconds: 400 }],
        assertions: [{ type: "popup_available" }],
        applicable: (context) => context.hasPopup,
        skipReason: "No popup is declared by this extension.",
      }),
    ],
  });

const contentScriptSuite = (): TestSuite =>
  createTestSuite({
    id: "content-script",
    name: "Content Script Test",
    description: "Opens the controlled target page and verifies content-script evidence.",
    tests: [
      createTestCase({
        id: "content-script-page",
        name: "Target page loads",
        description: "The controlled test page is reachable.",
        category: "page",
        severity: "medium",
        timeout: 10_000,
        steps: [
          { type: "open_url", url: TEST_PAGE },
          { type: "wait", milliseconds: 600 },
          { type: "inspect_element", selector: "#status" },
        ],
        assertions: [{ type: "element_exists", selector: "#status" }],
        applicable: () => true,
      }),
      createTestCase({
        id: "content-script-evidence",
        name: "Content script evidence",
        description: "Observable evidence that the content script ran on the page.",
        category: "content_script",
        severity: "high",
        timeout: 10_000,
        dependsOn: ["content-script-page"],
        steps: [
          { type: "wait", milliseconds: 1200 },
          { type: "inspect_text", selector: "#status" },
        ],
        assertions: [{ type: "content_script_detected" }],
        applicable: (context) => context.hasContentScripts,
        skipReason: "No content script is configured by this extension.",
      }),
    ],
  });

const serviceWorkerSuite = (): TestSuite =>
  createTestSuite({
    id: "service-worker",
    name: "Service Worker Test",
    description: "Extension loads and background/worker lifecycle evidence is captured without runtime errors.",
    tests: [
      createTestCase({
        id: "sw-lifecycle",
        name: "Background lifecycle evidence",
        description: "Background execution evidence is observed for the declared model.",
        category: "service_worker",
        severity: "medium",
        timeout: 12_000,
        steps: [{ type: "wait", milliseconds: 1500 }],
        assertions: [{ type: "service_worker_detected" }],
        applicable: (context) =>
          (context.manifestVersion === "v3" && context.hasServiceWorker) ||
          (context.manifestVersion === "v2" && context.hasBackground),
        skipReason: "No background execution is configured by this extension.",
      }),
      createTestCase({
        id: "sw-runtime-errors",
        name: "No runtime errors in background",
        description: "No fatal runtime errors were captured during background startup.",
        category: "console",
        severity: "high",
        timeout: 8_000,
        steps: [{ type: "wait", milliseconds: 1200 }],
        assertions: [{ type: "runtime_error_none" }],
        applicable: () => true,
      }),
    ],
  });

const permissionSmokeSuite = (): TestSuite =>
  createTestSuite({
    id: "permission-smoke",
    name: "Permission Smoke Test",
    description: "Extension loads and permission-related diagnostics are surfaced.",
    tests: [
      createTestCase({
        id: "permission-loads",
        name: "Extension loads with declared permissions",
        description: "The extension loads; permission diagnostics are collected.",
        category: "permissions",
        severity: "medium",
        timeout: 10_000,
        steps: [
          { type: "open_url", url: TEST_PAGE },
          { type: "wait", milliseconds: 1000 },
        ],
        assertions: [{ type: "extension_loaded" }, { type: "runtime_error_none" }],
        applicable: () => true,
      }),
    ],
  });

export const TEST_TEMPLATES: TestTemplate[] = [
  {
    id: "popup-smoke",
    suiteId: "popup-smoke",
    name: "Popup Smoke Test",
    description: "Extension loads, popup available, popup opens, basic UI exists.",
    advanced: false,
    build: popupSmokeSuite,
  },
  {
    id: "content-script",
    suiteId: "content-script",
    name: "Content Script Test",
    description: "Open target page, verify content-script evidence and expected text.",
    advanced: false,
    build: contentScriptSuite,
  },
  {
    id: "service-worker",
    suiteId: "service-worker",
    name: "Service Worker Test",
    description: "Extension loads, background lifecycle evidence, runtime errors.",
    advanced: true,
    build: serviceWorkerSuite,
  },
  {
    id: "permission-smoke",
    suiteId: "permission-smoke",
    name: "Permission Smoke Test",
    description: "Extension loads, expected runtime behavior, permission diagnostics.",
    advanced: true,
    build: permissionSmokeSuite,
  },
];

export function getTestTemplates(): TestTemplate[] {
  return TEST_TEMPLATES;
}

/**
 * Validates explicit dependencies: bounded count, no self-reference, no
 * cycles, references must exist in the same suite, and the chain depth stays
 * small. Throws on violation so bad suites can never execute.
 */
export function validateDependencies(tests: TestCase[]): void {
  const byId = new Map(tests.map((test) => [test.id, test]));
  const MAX_DEPENDENCIES = 3;
  const MAX_DEPTH = 5;
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const depth = (id: string, seen: Set<string> = new Set()): number => {
    if (seen.has(id)) throw new Error(`Circular test dependency involving "${id}".`);
    const test = byId.get(id);
    if (!test?.dependsOn || test.dependsOn.length === 0) return 0;
    seen.add(id);
    let max = 0;
    for (const dependency of test.dependsOn) {
      max = Math.max(max, 1 + depth(dependency, new Set(seen)));
    }
    return max;
  };

  for (const test of tests) {
    if (test.dependsOn) {
      if (test.dependsOn.length > MAX_DEPENDENCIES) {
        throw new Error(`Test "${test.id}" exceeds the dependency limit (${MAX_DEPENDENCIES}).`);
      }
      for (const dependency of test.dependsOn) {
        if (dependency === test.id) throw new Error(`Test "${test.id}" cannot depend on itself.`);
        if (!byId.has(dependency)) {
          throw new Error(`Test "${test.id}" depends on unknown test "${dependency}".`);
        }
      }
    }
    if (visited.has(test.id)) continue;
    visiting.clear();
    if (depth(test.id) > MAX_DEPTH) {
      throw new Error(`Test "${test.id}" exceeds the maximum dependency depth (${MAX_DEPTH}).`);
    }
    visited.add(test.id);
  }
}
