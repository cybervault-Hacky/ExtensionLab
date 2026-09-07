import { describe, it, expect } from "vitest";
import { validateCiConfig, sanitizeLog, resolvePolicies } from "@/lib/ci/service";
import { evaluateGates } from "@/lib/ci/gates";
import { existsSync, readFileSync } from "node:fs";

describe("Phase 16 — CI Integration", () => {
  describe("Configuration validation", () => {
    it("accepts valid minimal config", () => {
      const r = validateCiConfig({ project: "p", tests: ["t1"], browsers: ["chromium"] });
      expect(r.valid).toBe(true);
    });
    it("rejects unknown fields", () => {
      const r = validateCiConfig({ script: "bad" });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("Unknown"))).toBe(true);
    });
    it("rejects invalid browser", () => {
      const r = validateCiConfig({ browsers: ["safari"] });
      expect(r.valid).toBe(false);
    });
    it("rejects oversized test IDs", () => {
      const r = validateCiConfig({ tests: ["a".repeat(300)] });
      expect(r.valid).toBe(false);
    });
    it("never allows arbitrary command fields", () => {
      const r = validateCiConfig({ command: "rm -rf /", shell: true, eval: "bad" });
      expect(r.valid).toBe(false);
    });
  });

  describe("Gate policies", () => {
    it("passes when no failures", () => {
      expect(evaluateGates({ passed: 12, failed: 0, warnings: 0, skipped: 0, policies: ["FAIL_ON_TEST_FAILURE"] }).status).toBe("PASS");
    });
    it("fails on test failure", () => {
      expect(evaluateGates({ passed: 11, failed: 1, warnings: 0, skipped: 0, policies: ["FAIL_ON_TEST_FAILURE"] }).status).toBe("FAIL");
    });
    it("fails on regression", () => {
      expect(evaluateGates({ passed: 12, failed: 0, warnings: 0, skipped: 0, regressionDetected: true, policies: ["FAIL_ON_REGRESSION"] }).status).toBe("FAIL");
    });
    it("respects browser incompatibility policy", () => {
      expect(evaluateGates({ passed: 12, failed: 0, warnings: 0, skipped: 0, browserIncompatibility: true, policies: ["FAIL_ON_BROWSER_INCOMPATIBILITY"] }).status).toBe("FAIL");
    });
  });

  describe("Sanitization", () => {
    it("redacts authorization headers", () => {
      const out = sanitizeLog("api-key: secret123");
      expect(out).not.toContain("secret123");
      expect(out).toContain("[REDACTED]");
    });
    it("redacts long hex tokens", () => {
      const out = sanitizeLog("token=abcd1234ef567890ab1234567890abcd");
      expect(out).toContain("[HASH]");
    });
  });

  describe("Policy resolution", () => {
    it("defaults to conservative policies", () => {
      const p = resolvePolicies();
      expect(p).toContain("FAIL_ON_TEST_FAILURE");
      expect(p).toContain("FAIL_ON_REGRESSION");
    });
  });

  describe("Action artifacts exist", () => {
    it("has composite action", () => {
      expect(existsSync(".github/actions/extensionlab/action.yml")).toBe(true);
    });
  });

  describe("Secret scanning (basic)", () => {
    it("does not contain hardcoded api keys in new source", () => {
      const src = readFileSync(".github/actions/extensionlab/action.yml", "utf8");
      expect(src).not.toMatch(/sk-[a-zA-Z0-9]{20,}/); // fake key pattern
      expect(src).not.toMatch(/ghp_[a-zA-Z0-9]{30,}/);
    });
    it("does not contain hardcoded webhook secrets in docs", () => {
      const docs = readFileSync("docs/GITHUB_CI.md", "utf8");
      expect(docs).not.toContain("whsec_");
    });
  });

  describe("Database migration applied", () => {
    it("has ci_executions table reference in source or migration", () => {
      const mig = readFileSync("lib/db/migrations/013_phase16_ci.sql", "utf8");
      expect(mig).toContain("ci_executions");
    });
  });
});
