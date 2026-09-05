import { afterEach, beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

const V3_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "Compat Probe",
  version: "1.0",
  action: { default_popup: "popup.html" },
  background: { service_worker: "background.js" },
  permissions: ["storage", "tabs"],
});

async function analyze(files: Record<string, string>) {
  const analysis = await analyzeZipBytes(await makeZip(files), "probe.zip");
  expect(analysis.browserCompatibility).toBeDefined();
  return analysis.browserCompatibility!;
}

describe("static browser compatibility analysis (Phase 9)", () => {
  it("produces an informational, evidence-based verdict per browser and states runtime results stay authoritative", async () => {
    const compat = await analyze({ "manifest.json": V3_MANIFEST, "popup.html": "<html></html>", "background.js": "chrome.runtime.onInstalled.addListener(() => {});" });
    expect(compat.perBrowser).toHaveLength(3);
    const byId = Object.fromEntries(compat.perBrowser.map((entry) => [entry.browserId, entry]));
    expect(byId.chromium.verdict).toBe("supported");
    expect(byId.edge.verdict).toBe("supported");
    // Firefox gets notes (background model, no gecko target) → "review", never a failure claim.
    expect(byId.firefox.verdict).toBe("review");
    expect(compat.basis).toMatch(/informational/i);
    expect(compat.basis).toMatch(/authoritative/i);
    for (const note of compat.notes) {
      expect(note.severity === "info" || note.severity === "warning").toBe(true);
      expect(note.title).not.toMatch(/will fail|is broken|bug/i);
    }
  });

  it("records chrome.*/browser.* namespace usage with file evidence", async () => {
    const compat = await analyze({
      "manifest.json": V3_MANIFEST,
      "content.js": "if (typeof browser === 'undefined') { var browser = chrome; }\nbrowser.runtime.sendMessage('hi');",
    });
    const namespaces = compat.apiUsage.map((usage) => usage.namespace);
    expect(namespaces).toContain("browser");
    const browserUsage = compat.apiUsage.find((usage) => usage.namespace === "browser")!;
    expect(browserUsage.apis.some((api) => api.endsWith(".runtime"))).toBe(true);
    expect(browserUsage.files).toContain("content.js");
    // browser.* usage is called out for Chromium browsers, informationally.
    expect(compat.notes.some((note) => note.id === "browser-namespace-chromium")).toBe(true);
  });

  it("detects a bundled webextension polyfill as informational", async () => {
    const compat = await analyze({
      "manifest.json": V3_MANIFEST,
      "polyfill.js": "// webextension-polyfill v2\nexport default browser;",
    });
    expect(compat.polyfills).toHaveLength(1);
    expect(compat.polyfills[0].name).toMatch(/polyfill/i);
    expect(compat.polyfills[0].evidence).toBe("polyfill.js");
    expect(compat.polyfills[0].note).toMatch(/informational/i);
  });

  it("warns about Chromium-only permissions with guard advice, not verdicts", async () => {
    const manifest = JSON.stringify({
      manifest_version: 3,
      name: "Probe",
      version: "1.0",
      permissions: ["storage", "offscreen", "sidePanel", "declarativeNetRequest"],
    });
    const compat = await analyze({ "manifest.json": manifest, "background.js": "// ok" });
    const firefoxNotes = compat.notes.filter((note) => note.browsers.includes("firefox"));
    expect(firefoxNotes.some((note) => note.id === "permission-chromium-only-offscreen")).toBe(true);
    expect(firefoxNotes.some((note) => note.id === "permission-chromium-only-sidePanel")).toBe(true);
    expect(firefoxNotes.some((note) => note.id === "permission-partial-declarativeNetRequest")).toBe(true);
    const offscreen = firefoxNotes.find((note) => note.id === "permission-chromium-only-offscreen")!;
    expect(offscreen.detail).toMatch(/guard|feature-detect/i);
    const firefox = compat.perBrowser.find((entry) => entry.browserId === "firefox")!;
    expect(firefox.verdict).toBe("review");
  });

  it("notes MV2 as version-dependent on Chromium while Firefox stays supported", async () => {
    const mv2 = JSON.stringify({ manifest_version: 2, name: "Old", version: "1", background: { scripts: ["bg.js"] }, permissions: ["tabs"] });
    const compat = await analyze({ "manifest.json": mv2, "bg.js": "" });
    const chromium = compat.perBrowser.find((entry) => entry.browserId === "chromium")!;
    expect(chromium.noteIds).toContain("manifest-v2-chromium-phaseout");
    const firefox = compat.perBrowser.find((entry) => entry.browserId === "firefox")!;
    expect(firefox.verdict).toBe("supported");
    expect(compat.notes.find((note) => note.id === "manifest-v2-chromium-phaseout")?.detail).toMatch(/Firefox continues to support Manifest V2/i);
  });

  it("explains the MV3 background model difference on Firefox without claiming breakage", async () => {
    const compat = await analyze({ "manifest.json": V3_MANIFEST, "background.js": "// bg" });
    const note = compat.notes.find((entry) => entry.id === "mv3-background-model-gecko");
    expect(note).toBeDefined();
    expect(note!.detail).toMatch(/event page/i);
    expect(note!.detail).toMatch(/still loads/i);
  });

  it("notes when the manifest ships no Firefox-specific settings only when true", async () => {
    const withGecko = JSON.stringify({
      manifest_version: 3,
      name: "DualTarget",
      version: "1.0",
      browser_specific_settings: { gecko: { id: "x@example.com" } },
    });
    const targeted = await analyze({ "manifest.json": withGecko, "background.js": "// bg" });
    expect(targeted.notes.some((note) => note.id === "no-firefox-targeting")).toBe(false);
    const untargeted = await analyze({ "manifest.json": V3_MANIFEST, "background.js": "chrome.runtime.onMessage.addListener(() => {});" });
    const note = untargeted.notes.find((entry) => entry.id === "no-firefox-targeting");
    expect(note).toBeDefined();
    expect(note!.detail).toMatch(/can still load/i);
  });

  it("bounds scanning work for large extensions", async () => {
    const files: Record<string, string> = { "manifest.json": V3_MANIFEST };
    for (let i = 0; i < 200; i++) files[`script${i}.js`] = "// chrome.tabs.query(null, () => {})\n".repeat(50);
    const start = Date.now();
    const compat = await analyze(files);
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(compat.perBrowser).toHaveLength(3);
  });
});
