import "server-only";
import { getBuiltInSuites } from "./registry";
import { getTestTemplates, validateDependencies } from "./templates";
import type { TestCase, TestSuite } from "./types";
import type { ExtensionAnalysis } from "@/types/extension";
import { AppError } from "@/lib/observability/errors";

/**
 * Suite resolution for single runs and browser matrices.
 *
 * A suite id resolves either to a Phase 4 built-in suite (core, advanced) or a
 * Phase 9 template. Discovery still filters tests by applicability, and
 * dependency graphs are validated before anything executes.
 */

export interface ResolvedSuite {
  suite: TestSuite;
  /** Template flag: advanced suites require the advancedSuites entitlement. */
  advanced: boolean;
  tests: TestCase[];
}

export function listSelectableSuites(): Array<{ id: string; name: string; description: string; advanced: boolean; source: "builtin" | "template" }> {
  const builtIn = getBuiltInSuites().map((suite) => ({
    id: suite.id,
    name: suite.name,
    description: suite.description,
    advanced: false,
    source: "builtin" as const,
  }));
  const templates = getTestTemplates().map((template) => ({
    id: template.suiteId,
    name: template.name,
    description: template.description,
    advanced: template.advanced,
    source: "template" as const,
  }));
  return [...builtIn, ...templates];
}

export function resolveSuite(suiteId: string | undefined | null, analysis: ExtensionAnalysis): ResolvedSuite {
  const id = suiteId?.trim() || "core";
  const builtIn = getBuiltInSuites().find((suite) => suite.id === id);
  if (builtIn) {
    const tests = filterApplicable(builtIn.tests, analysis);
    validateDependencies(builtIn.tests);
    return { suite: builtIn, advanced: false, tests };
  }
  const template = getTestTemplates().find((entry) => entry.suiteId === id || entry.id === id);
  if (template) {
    const suite = template.build();
    const tests = filterApplicable(suite.tests, analysis);
    validateDependencies(suite.tests);
    return { suite, advanced: template.advanced, tests };
  }
  throw new AppError("INVALID_INPUT", { message: `Unknown test suite "${id}".` });
}

function filterApplicable(tests: TestCase[], analysis: ExtensionAnalysis): TestCase[] {
  const manifest = analysis.manifest;
  const context = {
    manifestVersion: manifest.manifestVersion,
    hasPopup: Boolean(manifest.features.action || manifest.features.browser_action || manifest.features.page_action),
    hasContentScripts: Boolean(manifest.features.content_scripts),
    hasServiceWorker: Boolean(manifest.features.background),
    hasBackground: Boolean(manifest.features.background),
    hasWebAccessibleResources: Boolean(manifest.features.web_accessible_resources),
    permissions: analysis.permissions.permissions,
    hostPermissions: analysis.permissions.hostPermissions,
    broadHostPermissions: analysis.permissions.broadPermissions,
  };
  return tests.filter((test) => test.applicable(context));
}
