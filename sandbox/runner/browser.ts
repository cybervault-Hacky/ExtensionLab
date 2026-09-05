/**
 * Phase 9: the concrete browser runner is selected per container via the
 * EXTENSIONLAB_BROWSER environment variable (set by the host Docker driver).
 * See sandbox/runner/browsers/* for the Chromium, Edge and Firefox adapters.
 */
export { createSandboxBrowser } from "./browsers";
export type { SandboxBrowser, SandboxBrowserId, ElementInspection } from "./browsers";
