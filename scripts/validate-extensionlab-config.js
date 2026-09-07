#!/usr/bin/env node
/** Phase 16: validate .extensionlab.yml without running tests. */
import { readFileSync, existsSync } from "node:fs";

const path = process.argv[2] || ".extensionlab.yml";
if (!existsSync(path)) {
  console.log("No .extensionlab.yml found; nothing to validate.");
  process.exit(0);
}

function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/);
  const obj = {};
  let currentArr = null;
  let currentKey = null;
  for (const rawLine of lines) {
    const line = rawLine.split("#")[0];
    if (!line.trim()) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") && line.length - line.trimStart().length <= 2) {
      if (!currentArr) {
        // Simple heuristic: previous non-empty line is key
        const prev = lines.slice(0, lines.indexOf(rawLine)).filter(l => l.trim() && !l.trim().startsWith("-")).pop();
        if (prev) currentKey = prev.trim().replace(/:.*$/, "");
        currentArr = [];
        obj[currentKey] = currentArr;
      }
      currentArr.push(trimmed.substring(2).trim());
    } else if (trimmed.includes(":")) {
      const idx = trimmed.indexOf(":");
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      if (val === "") {
        currentArr = null;
        currentKey = key;
      } else if (val === "true") obj[key] = true;
      else if (val === "false") obj[key] = false;
      else if (val === "[]") obj[key] = [];
      else if (!isNaN(Number(val)) && val !== "") obj[key] = Number(val);
      else obj[key] = val.replace(/^["']|["']$/g, "");
      currentArr = null;
    }
  }
  return obj;
}

function validateConfig(raw) {
  const errors = [];
  if (raw === null || typeof raw !== "object") {
    errors.push("Configuration must be an object.");
    return { valid: false, errors };
  }
  const allowed = new Set(["project", "tests", "browsers", "regression", "failOn"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) errors.push(`Unknown field: ${key}`);
  }
  if (raw.tests !== undefined) {
    if (!Array.isArray(raw.tests)) errors.push("tests must be an array.");
    else if (raw.tests.some((t) => typeof t !== "string" || t.length === 0 || t.length > 256)) errors.push("Invalid test ID.");
  }
  if (raw.browsers !== undefined) {
    const valid = new Set(["chromium", "edge", "firefox"]);
    if (!Array.isArray(raw.browsers)) errors.push("browsers must be an array.");
    else if (raw.browsers.some((b) => typeof b !== "string" || !valid.has(b))) errors.push("Invalid browser name.");
  }
  if (raw.regression !== undefined && (typeof raw.regression !== "object" || raw.regression === null)) {
    errors.push("regression must be an object.");
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [] };
}

try {
  const content = readFileSync(path, "utf8");
  const raw = parseSimpleYaml(content);
  const result = validateConfig(raw);
  if (result.valid) {
    console.log("ExtensionLab configuration valid.");
    process.exit(0);
  } else {
    for (const err of result.errors) console.log("Invalid: " + err);
    process.exit(1);
  }
} catch (e) {
  console.error("Configuration error:", e.message);
  process.exit(2);
}
