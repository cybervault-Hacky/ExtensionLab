import "server-only";
import { createTestCase } from "./test-case";
import { createTestSuite } from "./test-suite";
import type {
  TestCase,
  TestDiscoveryContext,
  TestSuite,
} from "./types";
import type { ExtensionAnalysis } from "@/types/extension";

/**
 * Built-in deterministic test registry.
 *
 * A test is only included when it is applicable to the current extension. The
 * applicability functions use static analysis and never generate fake results.
 */

const extensionLoadedTest = (): TestCase =>
  createTestCase({
    id: "extension-loads",
    name: "Extension loads",
    description: "Verify the extension actually loads in the isolated browser.",
    category: "loading",
    severity: "high",
    timeout: 10000,
    steps: [
      { type: "open_url", url: "http://127.0.0.1:8080/extensionlab-test" },
      { type: "wait", milliseconds: 1000 },
    ],
    assertions: [{ type: "extension_loaded" }],
    applicable: () => true,
  });

const pageLoadsTest = (): TestCase =>
  createTestCase({
    id: "test-page-loads",
    name: "Test page loads",
    description: "Verify the controlled test page loads after extension launch.",
    category: "page",
    severity: "high",
    timeout: 10000,
    steps: [
      { type: "open_url", url: "http://127.0.0.1:8080/extensionlab-test" },
      { type: "wait", milliseconds: 800 },
      { type: "inspect_element", selector: "#status" },
    ],
    assertions: [
      { type: "url_contains", value: "extensionlab-test" },
      { type: "element_exists", selector: "#status" },
    ],
    applicable: () => true,
  });

const contentScriptTest = (): TestCase =>
  createTestCase({
    id: "content-script",
    name: "Content script runs",
    description: "Verify observable evidence that a configured content script ran.",
    category: "content_script",
    severity: "medium",
    timeout: 10000,
    steps: [
      { type: "open_url", url: "http://127.0.0.1:8080/extensionlab-test" },
      { type: "wait", milliseconds: 1200 },
      { type: "inspect_element", selector: "#status" },
    ],
    assertions: [{ type: "content_script_detected" }],
    applicable: (context) => context.hasContentScripts,
    skipReason: "No content script is configured by this extension.",
  });

const serviceWorkerTest = (): TestCase =>
  createTestCase({
    id: "service-worker",
    name: "Service worker",
    description: "Verify service-worker registration events were observed.",
    category: "service_worker",
    severity: "medium",
    timeout: 10000,
    steps: [{ type: "wait", milliseconds: 1200 }],
    assertions: [{ type: "service_worker_detected" }],
    applicable: (context) =>
      context.manifestVersion === "v3" && context.hasServiceWorker,
    skipReason: "No service worker is configured for this manifest version.",
  });

const popupTest = (): TestCase =>
  createTestCase({
    id: "popup",
    name: "Popup availability",
    description: "Verify the declared popup is available in the sandbox.",
    category: "popup",
    severity: "medium",
    timeout: 5000,
    steps: [{ type: "open_popup" }],
    assertions: [{ type: "popup_available" }],
    applicable: (context) => context.hasPopup,
    skipReason: "No popup is declared by this extension.",
  });

const consoleErrorsTest = (): TestCase =>
  createTestCase({
    id: "console-runtime-errors",
    name: "No fatal runtime errors",
    description: "Check console evidence for fatal errors during startup.",
    category: "console",
    severity: "high",
    timeout: 6000,
    steps: [{ type: "wait", milliseconds: 1200 }],
    assertions: [{ type: "runtime_error_none" }],
    applicable: () => true,
  });

const networkTest = (): TestCase =>
  createTestCase({
    id: "network-requests",
    name: "Network requests observed",
    description: "Verify that the test page produced network activity without 5xx failures.",
    category: "network",
    severity: "medium",
    timeout: 8000,
    steps: [{ type: "wait", milliseconds: 1500 }],
    assertions: [{ type: "network_5xx_none" }],
    applicable: () => true,
  });

const broadPermissionsTest = (): TestCase =>
  createTestCase({
    id: "permissions-broad",
    name: "Broad permissions reviewed",
    description: "Flag broad host permissions for manual review.",
    category: "permissions",
    severity: "info",
    timeout: 2000,
    steps: [],
    assertions: [],
    applicable: (context) => context.broadHostPermissions,
    skipReason: "No broad host permissions are declared.",
  });

export function getBuiltInTestCases(): TestCase[] {
  return [
    extensionLoadedTest(),
    pageLoadsTest(),
    contentScriptTest(),
    serviceWorkerTest(),
    popupTest(),
    consoleErrorsTest(),
    networkTest(),
    broadPermissionsTest(),
  ];
}

export function getBuiltInSuites(): TestSuite[] {
  return [
    createTestSuite({
      id: "core",
      name: "Core Extension Suite",
      description: "Verifies extension loading, page loading, and runtime stability.",
      tests: [
        extensionLoadedTest(),
        pageLoadsTest(),
        serviceWorkerTest(),
        popupTest(),
        consoleErrorsTest(),
        networkTest(),
      ],
    }),
    createTestSuite({
      id: "advanced",
      name: "Advanced Diagnostics Suite",
      description: "Verifies content scripts, permissions, and runtime evidence.",
      tests: [
        contentScriptTest(),
        broadPermissionsTest(),
      ],
    }),
  ];
}

export function discoverTests(
  analysis: ExtensionAnalysis,
): { tests: TestCase[]; context: TestDiscoveryContext } {
  const context: TestDiscoveryContext = {
    manifestVersion: analysis.manifest.manifestVersion,
    hasPopup: analysis.manifest.features.action || analysis.manifest.features.browser_action || analysis.manifest.features.page_action,
    hasContentScripts: analysis.manifest.features.content_scripts,
    hasServiceWorker: analysis.manifest.features.background,
    hasBackground: analysis.manifest.features.background,
    hasWebAccessibleResources: analysis.manifest.features.web_accessible_resources,
    permissions: analysis.permissions.permissions,
    hostPermissions: analysis.permissions.hostPermissions,
    broadHostPermissions: analysis.permissions.broadPermissions,
  };

  const tests = getBuiltInTestCases().filter((test) => test.applicable(context));
  return { tests, context };
}

export function filterTests(
  tests: TestCase[],
  context: TestDiscoveryContext,
): TestCase[] {
  return tests.filter((test) => test.applicable(context));
}
