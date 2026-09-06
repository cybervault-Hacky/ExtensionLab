import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireSameOrigin, apiErrorResponse } from "@/lib/auth/api";
import { requireApiUser } from "@/lib/auth/api";
import { getTestTemplates } from "@/lib/testing/templates";
import { validateDefinition } from "@/lib/testing/saved-test-schema";
import { canUseAdvancedSuites } from "@/lib/billing/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tests/templates — studio templates (§29).
 *
 * Built-in templates (Extension Load, Popup, Content Script, Service Worker,
 * Options Page, Permission Smoke, Network Smoke…) reuse the Phase 9 template
 * registry. Each is projected into the studio's SavedTestDefinition shape and
 * re-validated through the same validator a hand-built test must pass —
 * templates can never carry anything the builder forbids. "Use Template"
 * copies the definition into a NEW draft; built-ins are never modified.
 */

function templateToDefinition(template: ReturnType<typeof getTestTemplates>[number]): {
  definition: ReturnType<typeof validateDefinition>;
  tests: number;
} | null {
  const suite = template.build();
  const first = suite.tests[0];
  if (!first) return null;
  // A studio template is one representative test case from the suite, plus a
  // note that the full built-in suite remains available via normal runs.
  const definition = validateDefinition({
    schemaVersion: 1,
    setup: [],
    actions: first.steps
      .filter((step) => step.type === "open_url" || step.type === "wait")
      .map((step) => ({ ...step })),
    assertions: first.assertions.map((assertion) => ({ ...assertion })),
    cleanup: [],
    variables: [],
    timeoutMs: first.timeout,
    category: first.category,
    severity: first.severity,
  });
  return { definition, tests: suite.tests.length };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const advanced = canUseAdvancedSuites(user.id).allowed;
    const templates = getTestTemplates()
      .filter((template) => !template.advanced || advanced)
      .map((template) => {
        const converted = templateToDefinition(template);
        return {
          id: template.id,
          name: template.name,
          description: template.description,
          advanced: template.advanced,
          suiteTests: converted?.tests ?? 0,
          definition: converted?.definition ?? null,
        };
      });
    return NextResponse.json({ templates });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
