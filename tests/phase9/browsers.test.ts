import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capabilitiesForBrowser } from "@/lib/browsers/capabilities";
import { getBrowserProfile, getBrowserRegistryConfig, listBrowserProfiles } from "@/lib/browsers/registry";
import { toPublicBrowser } from "@/lib/browsers/public";
import { isBrowserId } from "@/lib/browsers/types";
import { setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

describe("browser registry (Phase 9)", () => {
  it("defines exactly the three supported browser ids", () => {
    expect(isBrowserId("chromium")).toBe(true);
    expect(isBrowserId("edge")).toBe(true);
    expect(isBrowserId("firefox")).toBe(true);
    expect(isBrowserId("safari")).toBe(false);
    expect(isBrowserId({})).toBe(false);
  });

  it("never claims Edge is an independent engine", () => {
    const edge = getBrowserProfile("edge");
    expect(edge.engine).toBe("chromium");
    expect(edge.engineLabel).toMatch(/chromium/i);
    expect(getBrowserProfile("chromium").engine).toBe("chromium");
    expect(getBrowserProfile("firefox").engine).toBe("gecko");
  });

  it("reads versions and images from deployment configuration", () => {
    process.env.BROWSER_FIREFOX_VERSION = "128.0esr";
    process.env.BROWSER_EDGE_VERSION = "138.0";
    const config = getBrowserRegistryConfig();
    expect(config.versions.firefox).toBe("128.0esr");
    expect(config.versions.edge).toBe("138.0");
    expect(config.versions.chromium).toBe("bundled");
    delete process.env.BROWSER_FIREFOX_VERSION;
    delete process.env.BROWSER_EDGE_VERSION;
  });

  it("binds each browser to its own pinned image and load method", () => {
    const config = getBrowserRegistryConfig();
    expect(config.images.chromium).toBeTruthy();
    expect(config.images.edge).not.toBe(config.images.chromium);
    expect(config.images.firefox).not.toBe(config.images.chromium);
    expect(getBrowserProfile("firefox").extensionFormat).toBe("temporary-addon");
    expect(getBrowserProfile("chromium").extensionFormat).toBe("command-line-flag");
  });

  it("enforces configurable matrix limits with bounded values", () => {
    const limits = getBrowserRegistryConfig().limits;
    expect(limits.maxBrowsersPerMatrix).toBeGreaterThanOrEqual(1);
    expect(limits.maxBrowsersPerMatrix).toBeLessThanOrEqual(3);
    expect(limits.maxMatrixTests).toBeGreaterThan(0);
    expect(limits.matrixTimeoutMs).toBeGreaterThan(0);
    process.env.MAX_BROWSERS_PER_MATRIX = "99";
    expect(getBrowserRegistryConfig().limits.maxBrowsersPerMatrix).toBeLessThanOrEqual(3);
    delete process.env.MAX_BROWSERS_PER_MATRIX;
  });
});

describe("browser capabilities (Phase 9)", () => {
  it("marks MV2 as version-dependent on Chromium browsers, supported on Firefox", () => {
    expect(capabilitiesForBrowser("chromium").extensionManifestV2.support).toBe("version-dependent");
    expect(capabilitiesForBrowser("edge").extensionManifestV2.support).toBe("version-dependent");
    expect(capabilitiesForBrowser("firefox").extensionManifestV2.support).toBe("supported");
  });

  it("documents the Firefox background model difference instead of claiming breakage", () => {
    const firefox = capabilitiesForBrowser("firefox").serviceWorker;
    expect(firefox.support).toBe("partial");
    expect(firefox.note).toMatch(/event page/i);
  });

  it("marks Firefox response-status network diagnostics as unsupported so status assertions skip", () => {
    expect(capabilitiesForBrowser("firefox").networkStatusCodes.support).toBe("unsupported");
    expect(capabilitiesForBrowser("chromium").networkStatusCodes.support).toBe("supported");
  });

  it("keeps Chromium-family capability parity", () => {
    const chromium = capabilitiesForBrowser("chromium");
    const edge = capabilitiesForBrowser("edge");
    for (const key of Object.keys(chromium) as Array<keyof typeof chromium>) {
      expect(edge[key].support).toBe(chromium[key].support);
    }
  });
});

describe("public browser projection (Phase 9)", () => {
  it("never exposes images, executables or internal paths", () => {
    for (const profile of listBrowserProfiles()) {
      const view = toPublicBrowser(profile, { browserId: profile.browserId, available: true });
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(profile.containerImage);
      expect(serialized).not.toContain("executable");
      expect(serialized).not.toContain("image");
      expect(serialized).not.toContain("/"); // no paths of any kind
      expect(Object.keys(view).sort()).toEqual(["available", "browserId", "capabilities", "displayName", "engine", "engineLabel", "supported", "unavailableReason", "version"].filter((key) => key in view));
      expect(view.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("reports unavailability with a stable, non-sensitive reason", () => {
    const view = toPublicBrowser(getBrowserProfile("edge"), {
      browserId: "edge",
      available: false,
      reason: "image_missing",
    });
    expect(view.available).toBe(false);
    expect(view.unavailableReason).toBe("image_missing");
  });
});
