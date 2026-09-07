import { evaluateGates, type GatePolicy, type GateInput } from "./gates";

export interface CiConfig {
  project?: string;
  tests?: string[];
  browsers?: string[];
  regression?: { failOnNewFailure?: boolean; failOnPerformanceRegression?: boolean };
    failOn?: ("critical" | "high" | "medium" | "low")[];
}

export function validateCiConfig(raw: unknown): { valid: boolean; errors: string[]; config?: CiConfig } {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object") {
    errors.push("Configuration must be an object.");
    return { valid: false, errors };
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(["project", "tests", "browsers", "regression", "failOn"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`Unknown field: ${key}`);
  }
  if (obj.tests !== undefined) {
    if (!Array.isArray(obj.tests)) errors.push("tests must be an array.");
    else if (obj.tests.some((t) => typeof t !== "string" || t.length === 0 || t.length > 256)) errors.push("Invalid test ID.");
  }
  if (obj.browsers !== undefined) {
    const validBrowsers = new Set(["chromium", "edge", "firefox"]);
    if (!Array.isArray(obj.browsers)) errors.push("browsers must be an array.");
    else if (obj.browsers.some((b) => typeof b !== "string" || !validBrowsers.has(b))) errors.push("Invalid browser name.");
  }
  if (obj.regression !== undefined && (typeof obj.regression !== "object" || obj.regression === null)) {
    errors.push("regression must be an object.");
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], config: obj as CiConfig };
}

export function resolvePolicies(config?: CiConfig): GatePolicy[] {
  const policies: GatePolicy[] = [];
  if (config?.regression?.failOnNewFailure) policies.push("FAIL_ON_REGRESSION");
  if (config?.regression?.failOnPerformanceRegression) policies.push("FAIL_ON_PERFORMANCE_REGRESSION");
  if (policies.length === 0) policies.push("FAIL_ON_TEST_FAILURE", "FAIL_ON_REGRESSION");
  return policies;
}

export function sanitizeLog(value: string): string {
  // Basic redaction for authorization headers and keys
  return value
    .replace(/(authorization|bearer|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
    .replace(/\b[a-f0-9]{32,64}\b/gi, "[HASH]");
}
