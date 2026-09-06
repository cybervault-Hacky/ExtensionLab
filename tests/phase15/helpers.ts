import JSZip from "jszip";
import { storeExtensionPackage } from "@/lib/packages/service";
import { setupHarness as setupPhase10Harness, type Harness } from "../phase10/helpers";
import { makeUser } from "../phase9/helpers";
import type { UserRecord } from "@/lib/db/repositories/users";

export { setupHarness, makeUser, activatePlan, activateUserPlan, ALL_BROWSERS_HEALTHY } from "../phase10/helpers";
export type { Harness } from "../phase10/helpers";

/** Phase 15 harness: same isolated DB + storage as Phase 10–14. */
export const setupPhase15Harness = (env: Record<string, string> = {}): Harness => setupPhase10Harness(env);

export const STUDIO_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "Studio Fixture",
  version: "2.0.0",
  action: { default_popup: "popup.html" },
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"] }],
});

export async function studioFixtureZip(manifest: string = STUDIO_MANIFEST): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", manifest);
  zip.file("background.js", "chrome.runtime.onInstalled.addListener(() => {});");
  zip.file("popup.html", '<!doctype html><html><body><button id="go">Go</button></body></html>');
  zip.file("content.js", "console.log('content script');");
  return zip.generateAsync({ type: "uint8array" });
}

/** A minimal, fully valid studio definition (allowlisted actions only). */
export function validDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    setup: [],
    actions: [
      { type: "open_url", url: "{{test_url}}" },
      { type: "wait", milliseconds: 300 },
      { type: "inspect_element", selector: "[data-testid=\"status\"]" },
    ],
    assertions: [
      { type: "extension_loaded" },
      { type: "element_exists", selector: "[data-testid=\"status\"]" },
    ],
    cleanup: [],
    variables: [{ name: "search_term", type: "text", maxLength: 40, required: true, defaultValue: "default-term" }],
    timeoutMs: 15000,
    category: "loading",
    severity: "high",
  };
}

/** Stores a package and returns its id (personal workspace). */
export async function storedStudioPackage(user: UserRecord, manifest: string = STUDIO_MANIFEST): Promise<{ packageId: string; sha256: string }> {
  const stored = await storeExtensionPackage({ userId: user.id, bytes: await studioFixtureZip(manifest), fileName: "studio.zip" });
  return { packageId: stored.package.id, sha256: stored.package.sha256 };
}

/** A package with DIFFERENT bytes (bumped version) under the same owner. */
export async function storedDifferentPackage(user: UserRecord): Promise<{ packageId: string; sha256: string }> {
  return storedStudioPackage(user, JSON.stringify({ ...JSON.parse(STUDIO_MANIFEST), version: "3.0.0" }));
}
