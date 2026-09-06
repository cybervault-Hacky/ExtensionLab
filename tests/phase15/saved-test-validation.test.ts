import { describe, expect, it } from "vitest";
import {
  SAVED_TEST_LIMITS,
  SAVED_TEST_SCHEMA_VERSION,
  SavedTestValidationError,
  checkVariableReferences,
  resolveVariables,
  validateDefinition,
  validateTags,
} from "@/lib/testing/saved-test-schema";
import { validDefinition } from "./helpers";

/**
 * Phase 15 §11/§12/§82: the definition schema is the security boundary for
 * saved tests. Nothing executable, nothing unbounded, nothing unexpected can
 * enter a definition — the same validator guards save, import and execution.
 */

describe("saved-test definition validation", () => {
  it("accepts a fully allowlisted definition", () => {
    const definition = validateDefinition(validDefinition());
    expect(definition.schemaVersion).toBe(SAVED_TEST_SCHEMA_VERSION);
    expect(definition.actions).toHaveLength(3);
    expect(definition.assertions).toHaveLength(2);
  });

  it("rejects every non-allowlisted action type (no execute_js, run_shell, raw_cdp…)", () => {
    for (const type of ["execute_js", "evaluate", "run_shell", "raw_cdp", "docker_exec", "arbitrary_command", "press_key", "upload_file"]) {
      const definition = validDefinition();
      (definition.actions as Array<Record<string, unknown>>)[0] = { type, value: "1+1" };
      expect(() => validateDefinition(definition), type).toThrow(SavedTestValidationError);
    }
  });

  it("rejects unknown fields at every level (strict import validation)", () => {
    const withTopField = validDefinition();
    (withTopField as Record<string, unknown>).evil = "x";
    expect(() => validateDefinition(withTopField)).toThrow(/Unexpected field "evil"/);

    const withStepField = validDefinition();
    (withStepField.actions as Array<Record<string, unknown>>)[0].script = "alert(1)";
    expect(() => validateDefinition(withStepField)).toThrow(/Unexpected field "script"/);

    const withAssertionField = validDefinition();
    (withAssertionField.assertions as Array<Record<string, unknown>>)[0].expression = "return true";
    expect(() => validateDefinition(withAssertionField)).toThrow(/Unexpected field "expression"/);
  });

  it("rejects selectors outside the safe grammar (nth-child, deep paths, injection)", () => {
    for (const selector of ["div:nth-child(2)", "div > div > span", "button[onclick='x']", "#id script", "*, .a.b.c"]) {
      const definition = validDefinition();
      (definition.actions as Array<Record<string, unknown>>)[2] = { type: "inspect_element", selector };
      expect(() => validateDefinition(definition), selector).toThrow(SavedTestValidationError);
    }
  });

  it("accepts exactly the safe selector strategies", () => {
    for (const selector of ["#submit", ".toolbar", "button", "[data-testid=\"status\"]"]) {
      const definition = validDefinition();
      (definition.actions as Array<Record<string, unknown>>)[2] = { type: "inspect_element", selector };
      expect(validateDefinition(definition).actions[2].selector, selector).toBe(selector);
    }
  });

  it("bounds waits, timeouts, values and step counts", () => {
    const slow = validDefinition();
    (slow.actions as Array<Record<string, unknown>>)[1] = { type: "wait", milliseconds: 9000 };
    expect(() => validateDefinition(slow)).toThrow(/milliseconds/);

    const longTimeout = validDefinition();
    (longTimeout as Record<string, unknown>).timeoutMs = 500_000;
    expect(() => validateDefinition(longTimeout)).toThrow(/timeoutMs/);

    const tooManySteps = validDefinition();
    (tooManySteps as Record<string, unknown>).actions = Array.from({ length: SAVED_TEST_LIMITS.maxSteps + 1 }, () => ({ type: "wait", milliseconds: 10 }));
    expect(() => validateDefinition(tooManySteps)).toThrow(/at most/i);

    const longValue = validDefinition();
    (longValue.actions as Array<Record<string, unknown>>)[0] = { type: "open_url", url: `https://x.example/${"a".repeat(3000)}` };
    expect(() => validateDefinition(longValue)).toThrow(/too long/i);
  });

  it("enforces variable rules: reserved names, duplicates, unknown references", () => {
    const reserved = validDefinition();
    (reserved.variables as Array<Record<string, unknown>>)[0] = { name: "browser", type: "text" };
    expect(() => validateDefinition(reserved)).toThrow(/reserved/i);

    const duplicate = validDefinition();
    (duplicate.variables as unknown as Array<Record<string, unknown>>).push({ name: "search_term", type: "text" });
    expect(() => validateDefinition(duplicate)).toThrow(/Duplicate/i);

    const unknownReference = validDefinition();
    (unknownReference.actions as Array<Record<string, unknown>>)[0] = { type: "open_url", url: "{{not_defined}}" };
    expect(() => validateDefinition(unknownReference)).toThrow(/unknown variable/i);

    expect(() => checkVariableReferences("{{ok}}", new Set(["ok"]))).not.toThrow();
    expect(() => checkVariableReferences("{{nope}}", new Set(["ok"]))).toThrow(/unknown variable/i);
  });

  it("bounds tags (count, length, charset, duplicates)", () => {
    expect(validateTags(["smoke", "ci"])).toEqual(["smoke", "ci"]);
    expect(() => validateTags(Array.from({ length: SAVED_TEST_LIMITS.maxTags + 1 }, (_, index) => `t${index}`))).toThrow(/at most/i);
    expect(() => validateTags(["UPPER"])).toThrow(/invalid/i);
    expect(() => validateTags(["with space"])).toThrow(/invalid/i);
    expect(() => validateTags(["dup", "dup"])).toThrow(/Duplicate/i);
  });

  it("rejects oversized definitions before any deeper parsing", () => {
    const huge = validDefinition();
    (huge as Record<string, unknown>).description = "x".repeat(SAVED_TEST_LIMITS.maxDefinitionBytes);
    expect(() => validateDefinition({ ...huge, schemaVersion: 1 })).toThrow(/too large|Unexpected/i);
  });

  it("rejects wrong schemaVersion", () => {
    const wrong = validDefinition();
    (wrong as Record<string, unknown>).schemaVersion = 2;
    expect(() => validateDefinition(wrong)).toThrow(/schemaVersion/i);
  });
});

describe("variable resolution (server-side substitution, never evaluation)", () => {
  const definition = validateDefinition(validDefinition());

  it("substitutes predefined variables from server context", () => {
    const resolved = resolveVariables(definition, {
      extensionName: "Studio Fixture",
      browser: "chromium",
      testUrl: "https://target.example/page",
      packageVersion: "2.0.0",
      provided: { search_term: "hello" },
    });
    expect(resolved.actions[0]).toEqual({ type: "open_url", url: "https://target.example/page" });
  });

  it("type-checks user-supplied values (number/boolean/url)", () => {
    const withNumber = validateDefinition({
      ...validDefinition(),
      variables: [{ name: "count", type: "number" }, { name: "flag", type: "boolean" }, { name: "target", type: "url" }],
    });
    const context = {
      extensionName: "e",
      browser: "chromium",
      testUrl: "https://t.example",
      packageVersion: "1",
    };
    expect(() => resolveVariables(withNumber, { ...context, provided: { count: "12", flag: "true", target: "https://ok.example" } })).not.toThrow();
    expect(() => resolveVariables(withNumber, { ...context, provided: { count: "abc" } })).toThrow(/number/i);
    expect(() => resolveVariables(withNumber, { ...context, provided: { flag: "yes" } })).toThrow(/true or false/i);
    expect(() => resolveVariables(withNumber, { ...context, provided: { target: "javascript:alert(1)" } })).toThrow(/http\(s\) URL/i);
    expect(() => resolveVariables(withNumber, { ...context, provided: { target: "not a url" } })).toThrow(/http\(s\) URL/i);
  });

  it("requires required variables and honors maxLength", () => {
    const withRequired = validateDefinition({ ...validDefinition(), variables: [{ name: "term", type: "text", required: true, maxLength: 5 }] });
    const context = { extensionName: "e", browser: "chromium", testUrl: "https://t.example", packageVersion: "1" };
    expect(() => resolveVariables(withRequired, { ...context })).toThrow(/required/i);
    expect(() => resolveVariables(withRequired, { ...context, provided: { term: "toolongvalue" } })).toThrow(/maximum length/i);
  });
});
