import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { analyzeZipBytes } from "@/lib/extension/analyzer";
import { ExtensionLabError } from "@/lib/extension/errors";
import { validateExtensionFile } from "@/lib/extension/validation";
import { MAX_EXTENSION_SIZE } from "@/lib/extension/limits";

async function makeZip(
  files: Record<string, string>,
  topLevelFolder = "",
): Promise<Uint8Array> {
  const zip = new JSZip();
  const base = topLevelFolder ? `${topLevelFolder}/` : "";
  for (const [path, content] of Object.entries(files)) {
    zip.file(`${base}${path}`, content);
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return bytes;
}

function makeFileLike(name: string, size: number, type = "application/zip"): File {
  const bytes = new Uint8Array(size);
  return new File([bytes], name, { type });
}

describe("analyzeZipBytes", () => {
  it("runs a valid Manifest V3 through and returns a report", async () => {
    const bytes = await makeZip({
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        name: "Sample Extension",
        version: "1.2.0",
        description: "A sample extension.",
        permissions: ["storage", "tabs"],
        host_permissions: ["https://example.com/*"],
        background: { service_worker: "background.js" },
        action: { default_popup: "popup.html" },
      }),
      "background.js": "// background",
      "popup.html": "<!doctype html>",
    });

    const analysis = await analyzeZipBytes(bytes, "sample.zip");
    expect(analysis.metadata.manifestVersionLabel).toBe("Manifest V3");
    expect(analysis.metadata.name).toBe("Sample Extension");
    expect(analysis.metadata.version).toBe("1.2.0");
    expect(analysis.permissions.permissions).toEqual(["storage", "tabs"]);
    expect(analysis.permissions.hostPermissions).toEqual([
      "https://example.com/*",
    ]);
    expect(analysis.healthScore.total).toBeGreaterThanOrEqual(90);
    expect(analysis.issues.some((issue) => issue.severity === "failed")).toBe(false);
  });

  it("detects Manifest V2 and records an informational warning", async () => {
    const bytes = await makeZip({
      "manifest.json": JSON.stringify({
        manifest_version: 2,
        name: "Legacy Extension",
        version: "0.0.1",
        background: { scripts: ["background.js"] },
        permissions: ["tabs"],
      }),
      "background.js": "// background",
    });

    const analysis = await analyzeZipBytes(bytes, "legacy.zip");
    expect(analysis.metadata.manifestVersionLabel).toBe("Manifest V2");
    expect(
      analysis.issues.some(
        (issue) => issue.id === "manifest-v2-compat" && issue.severity === "info",
      ),
    ).toBe(true);
  });

  it("reports a package with no manifest as an error", async () => {
    const bytes = await makeZip({ "readme.txt": "hello" });

    await expect(analyzeZipBytes(bytes, "empty-package.zip")).rejects.toMatchObject({
      code: "manifest-missing",
    });
  });

  it("reports invalid JSON as an error", async () => {
    const bytes = await makeZip({ "manifest.json": "{ invalid json" });

    await expect(analyzeZipBytes(bytes, "broken.zip")).rejects.toMatchObject({
      code: "manifest-invalid",
    });
  });

  it("warns when a referenced service worker is missing", async () => {
    const bytes = await makeZip({
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        name: "Missing Worker",
        version: "1.0.0",
        background: { service_worker: "background.js" },
      }),
    });

    const analysis = await analyzeZipBytes(bytes, "missing-worker.zip");
    expect(
      analysis.issues.some(
        (issue) =>
          issue.category === "structure" &&
          issue.message.includes("background.service_worker"),
      ),
    ).toBe(true);
  });

  it("detects common manifest features and config", async () => {
    const bytes = await makeZip({
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        name: "Feature Rich",
        version: "1.0.0",
        action: { default_popup: "popup.html" },
        content_scripts: [{ js: ["content.js"], matches: ["https://example.com/*"] }],
        options_page: "options.html",
        icons: { 128: "icons/icon128.png" },
        commands: { "toggle-feature": {} },
        content_security_policy: "script-src 'self'; object-src 'self'",
        web_accessible_resources: [{ resources: ["images/*"], matches: ["<all_urls>"] }],
      }),
      "popup.html": "<!doctype html>",
      "content.js": "// content",
      "options.html": "<!doctype html>",
      "icons/icon128.png": "png",
      "images/pic.png": "png",
    });

    const analysis = await analyzeZipBytes(bytes, "features.zip");
    expect(analysis.manifest.features.action).toBe(true);
    expect(analysis.manifest.features.content_scripts).toBe(true);
    expect(analysis.manifest.features.options_page).toBe(true);
    expect(analysis.manifest.features.icons).toBe(true);
    expect(analysis.manifest.features.commands).toBe(true);
    expect(analysis.manifest.features.content_security_policy).toBe(true);
    expect(analysis.manifest.features.web_accessible_resources).toBe(true);
    expect(analysis.manifest.detectedConfig.find((item) => item.label === "Action / Popup")?.present).toBe(true);
    expect(analysis.manifest.detectedConfig.find((item) => item.label === "Icons")?.present).toBe(true);
  });

  it("extracts permissions and optional permissions", async () => {
    const bytes = await makeZip({
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        name: "Permissions",
        version: "1.0.0",
        permissions: ["storage", "scripting"],
        optional_permissions: ["tabs"],
      }),
    });

    const analysis = await analyzeZipBytes(bytes, "permissions.zip");
    expect(analysis.permissions.permissions).toEqual(["scripting", "storage"]);
    expect(analysis.permissions.optionalPermissions).toEqual(["tabs"]);
    expect(analysis.permissions.categorized).toHaveLength(3);
  });

  it("extracts host permissions and flags broad access", async () => {
    const bytes = await makeZip({
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        name: "Broad Host",
        version: "1.0.0",
        host_permissions: ["<all_urls>"],
      }),
    });

    const analysis = await analyzeZipBytes(bytes, "broad-host.zip");
    expect(analysis.permissions.hostPermissions).toEqual(["<all_urls>"]);
    expect(analysis.permissions.broadPermissions).toBe(true);
    expect(analysis.issues.some((issue) => issue.id === "broad-host-access")).toBe(true);
  });

  it("builds a file tree with root files and nested folders", async () => {
    const bytes = await makeZip({
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        name: "Tree",
        version: "1.0.0",
      }),
      "background.js": "// background",
      "content/content.js": "// content",
      "icons/icon128.png": "png",
    });

    const analysis = await analyzeZipBytes(bytes, "tree.zip");
    const names = analysis.files.tree.map((node) => node.name);
    expect(names).toContain("manifest.json");
    expect(names).toContain("background.js");
    expect(names).toContain("content");
    expect(names).toContain("icons");

    const content = analysis.files.tree.find((node) => node.name === "content");
    expect(content?.children.map((child) => child.name)).toContain("content.js");
    const icons = analysis.files.tree.find((node) => node.name === "icons");
    expect(icons?.children.map((child) => child.name)).toContain("icon128.png");
  });

  it("finds a manifest nested inside a top-level folder", async () => {
    const bytes = await makeZip(
      {
        "manifest.json": JSON.stringify({
          manifest_version: 3,
          name: "Nested Extension",
          version: "2.0.0",
          background: { service_worker: "background.js" },
        }),
        "background.js": "// background",
      },
      "my-extension",
    );

    const analysis = await analyzeZipBytes(bytes, "nested.zip");
    expect(analysis.files.rootPath).toBe("my-extension");
    expect(analysis.metadata.name).toBe("Nested Extension");
    expect(analysis.issues.some((issue) => issue.severity === "warning")).toBe(false);
  });

  it("rejects an oversized file during validation", () => {
    const file = makeFileLike("large.zip", MAX_EXTENSION_SIZE + 1);
    const result = validateExtensionFile(file);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("file-too-large");
  });

  it("rejects unsupported files during validation", () => {
    expect(validateExtensionFile(makeFileLike("malware.exe", 10)).ok).toBe(false);
    expect(validateExtensionFile(makeFileLike("notes.txt", 10)).ok).toBe(false);
    expect(validateExtensionFile(makeFileLike("photo.png", 10)).ok).toBe(false);
  });

  it("accepts a valid ZIP file during validation", () => {
    const result = validateExtensionFile(makeFileLike("valid.zip", 10));
    expect(result.ok).toBe(true);
  });

  it("reports an empty ZIP as an error", async () => {
    const zip = new JSZip();
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(analyzeZipBytes(bytes, "empty.zip")).rejects.toMatchObject({
      code: "zip-empty",
    });
  });

  it("returns a graceful error for a corrupted ZIP", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
    let caught: unknown;
    try {
      await analyzeZipBytes(bytes, "corrupt.zip");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExtensionLabError);
    const extensionError = caught as ExtensionLabError;
    expect(extensionError.code).toBe("zip-corrupt");
    expect(extensionError.message).toMatch(/corrupted|couldn't read/i);
  });
});
