import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTION_REQUIRED_CAPABILITIES, ASSERTION_REQUIRED_CAPABILITIES, isActionSupported, isAssertionSupported, staticallySkippedTestsForBrowser } from "@/lib/browsers/test-compat";
import { getBrowserProfile } from "@/lib/browsers/registry";
import { validateSelector } from "@/lib/testing/selectors";
import { resolveSuite } from "@/lib/testing/suites";
import { validateDependencies } from "@/lib/testing/templates";
import { createTestCase } from "@/lib/testing/test-case";
import { AppError } from "@/lib/observability/errors";
import { setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

describe("capability gating for assertions and actions (Phase 9)", () => {
  it("requires network status capability only for status-based assertions", () => {
    expect(ASSERTION_REQUIRED_CAPABILITIES.network_5xx_none).toContain("networkStatusCodes");
    expect(ASSERTION_REQUIRED_CAPABILITIES.network_request_seen).toContain("networkEvents");
    expect(ASSERTION_REQUIRED_CAPABILITIES.network_request_seen).not.toContain("networkStatusCodes");
    expect(ASSERTION_REQUIRED_CAPABILITIES.element_exists).toHaveLength(0);
  });

  it("gates network status assertions as unsupported on Firefox (skip, not fail)", () => {
    const firefox = getBrowserProfile("firefox");
    const statusAssertion = isAssertionSupported(firefox, "network_status_equals");
    expect(statusAssertion.supported).toBe(false);
    expect(statusAssertion.unsupported).toContain("networkStatusCodes");
    const chromium = getBrowserProfile("chromium");
    expect(isAssertionSupported(chromium, "network_status_equals").supported).toBe(true);
  });

  it("keeps every safe action supported on every browser except capability-bound ones", () => {
    const actions = Object.keys(ACTION_REQUIRED_CAPABILITIES);
    expect(actions).toEqual(
      expect.arrayContaining(["open_url", "reload_page", "wait", "click", "type", "select", "scroll", "inspect_text", "inspect_element", "open_popup", "clear_console", "capture_screenshot"]),
    );
    for (const browserId of ["chromium", "edge", "firefox"] as const) {
      const profile = getBrowserProfile(browserId);
      for (const action of ["open_url", "click", "type", "inspect_element"] as const) {
        expect(isActionSupported(profile, action).supported).toBe(true);
      }
    }
  });

  it("statically skips only the MV3 service-worker test on Firefox", () => {
    const firefox = getBrowserProfile("firefox");
    const rules = staticallySkippedTestsForBrowser(firefox, { manifestVersion: "v3", hasServiceWorker: true });
    expect(rules).toHaveLength(1);
    expect(rules[0].applies("service-worker")).toBe(true);
    expect(rules[0].applies("popup")).toBe(false);
    expect(staticallySkippedTestsForBrowser(firefox, { manifestVersion: "v2", hasServiceWorker: false })).toHaveLength(0);
    const chromium = getBrowserProfile("chromium");
    expect(staticallySkippedTestsForBrowser(chromium, { manifestVersion: "v3", hasServiceWorker: true })).toHaveLength(0);
  });
});

describe("selector safety across browsers (unchanged Phase 4 guarantees)", () => {
  it("still rejects arbitrary JavaScript-ish selectors on every path", () => {
    expect(validateSelector("#ok-id").ok).toBe(true);
    expect(validateSelector(".class-name").ok).toBe(true);
    expect(validateSelector("button").ok).toBe(true);
    expect(validateSelector("[data-testid=\"x\"]").ok).toBe(true);
    expect(validateSelector("div << script").ok).toBe(false);
    expect(validateSelector("a[href^='javascript:']").ok).toBe(false);
    expect(validateSelector("*").ok).toBe(false);
    expect(validateSelector("#id, div").ok).toBe(false);
  });
});

describe("test suites and templates (Phase 9)", () => {
  it("resolves built-in and template suites with dependency validation", () => {
    const analysis = minimalAnalysis("v3");
    const core = resolveSuite("core", analysis);
    expect(core.suite.id).toBe("core");
    expect(core.advanced).toBe(false);
    const popup = resolveSuite("popup-smoke", analysis);
    expect(popup.suite.tests.length).toBeGreaterThan(0);
    expect(() => resolveSuite("does-not-exist", analysis)).toThrow(AppError);
  });

  it("rejects unknown suites", () => {
    expect(() => resolveSuite("nope", minimalAnalysis("v3"))).toThrow();
  });

  it("marks advanced templates as advanced for entitlement checks", () => {
    const analysis = minimalAnalysis("v3");
    expect(resolveSuite("service-worker", analysis).advanced).toBe(true);
    expect(resolveSuite("permission-smoke", analysis).advanced).toBe(true);
    expect(resolveSuite("content-script", analysis).advanced).toBe(false);
  });

  it("rejects circular and oversized dependency graphs", () => {
    const base = (id: string, dependsOn?: string[]) =>
      createTestCase({
        id,
        name: id,
        description: "",
        category: "page",
        severity: "info",
        timeout: 1000,
        steps: [],
        assertions: [],
        applicable: () => true,
        ...(dependsOn ? { dependsOn } : {}),
      });
    expect(() => validateDependencies([base("a", ["b"]), base("b", ["a"])])).toThrow(/circular/i);
    expect(() => validateDependencies([base("a", ["a"])])).toThrow(/itself/i);
    expect(() => validateDependencies([base("a", ["missing"])])).toThrow(/unknown/i);
    expect(() => validateDependencies([base("a", ["b", "c", "d", "e"])])).toThrow(/limit/i);
    expect(() => validateDependencies([base("a"), base("b", ["a"]), base("c", ["b"]), base("d", ["c"]), base("e", ["d"]), base("f", ["e"]), base("g", ["f"])])).toThrow(/depth/i);
    expect(() => validateDependencies([base("a"), base("b", ["a"])])).not.toThrow();
  });
});

function minimalAnalysis(manifestVersion: "v2" | "v3") {
  return {
    createdAt: Date.now(),
    sourceName: "test.zip",
    sourceSize: 10,
    rootPath: "",
    metadata: { name: "Test", manifestVersionLabel: `Manifest ${manifestVersion}` },
    manifest: {
      manifestVersion,
      manifestVersionLabel: `Manifest ${manifestVersion}`,
      features: { action: manifestVersion === "v3", background: true, content_scripts: true },
      raw: {},
    },
    permissions: { permissions: [], hostPermissions: [], optionalPermissions: [], categorized: [], broadPermissions: false },
    files: { entries: [], tree: [], rootPath: "", rootLabel: "root", totalUncompressedSize: 0, fileCount: 0 },
    issues: [],
    healthScore: { total: 100, categories: [], basis: "test" },
  } as never;
}
