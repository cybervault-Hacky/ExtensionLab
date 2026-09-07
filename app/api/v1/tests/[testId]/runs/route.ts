import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withApiKey, apiErrorResponse } from "@/lib/api/v1-support";
import { withIdempotency } from "@/lib/idempotency/service";
import { recordAuditEvent } from "@/lib/audit/service";
import { auditApiKeyUse } from "@/lib/api-keys/service";
import { dispatchOrganizationEvent } from "@/lib/webhooks/dispatch";
import { getAccessibleSavedTest } from "@/lib/db/repositories/saved-tests";
import { listTestRuns } from "@/lib/db/repositories/test-runs";
import { runStudioTest, runStudioTestMatrix, runStudioSuite } from "@/lib/testing/studio-service";
import { AppError } from "@/lib/observability/errors";
import { isBrowserId, type BrowserId } from "@/lib/browsers/types";
import { getDb } from "@/lib/db/client";
import { ciRunView } from "@/lib/api/v1-tests-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 15 CI endpoints for saved tests.
 *
 * POST /api/v1/tests/:testId/runs — trigger a run of a saved test (or its
 * suite) using an existing API key with the `tests:write` scope. All the
 * server-side gates the dashboard uses apply unchanged: entitlements, quota
 * reservation, per-user concurrency, exact package SHA-256 binding, selector
 * and action validation. Parameters are validated server-side; anything not
 * in the allowlist below is rejected. Idempotency-Key is honored.
 *
 * GET /api/v1/tests/:testId/runs — recent runs of the test (paginated) with
 * the CI status enum (QUEUED/STARTING/RUNNING/COMPLETED/FAILED/TIMEOUT/
 * CANCELLED). Polling only — no SSE required (§53).
 */

const MAX_VARIABLES = 10;
const MAX_VARIABLE_VALUE = 2000;

function studioViewer(context: { principal: { organizationId: string; apiKey: { created_by: string } } }) {
  return { userId: context.principal.apiKey.created_by, organizationId: context.principal.organizationId };
}

export async function POST(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  const { testId } = await context.params;
  return withApiKey(request, { scope: "tests:write", rateClass: "test", action: "org:tests:run" }, async (apiContext) => {
    try {
      const viewer = studioViewer(apiContext);
      const test = getAccessibleSavedTest({ userId: viewer.userId, organizationId: viewer.organizationId }, testId);
      if (!test) throw new AppError("NOT_FOUND", { message: "Test not found." });

      const body = (await request.json().catch(() => null)) as {
        version?: unknown;
        browser?: unknown;
        browsers?: unknown;
        variables?: unknown;
        testUrl?: unknown;
        provider?: unknown;
        repository?: unknown;
        commitSha?: unknown;
        branch?: unknown;
        tag?: unknown;
        workflow?: unknown;
        workflowRunId?: unknown;
        pullRequestNumber?: unknown;
      } | null;
      if (body === null) throw new AppError("INVALID_INPUT", { message: "A JSON body is required." });

      // Safe parameter allowlist (§52): every field is validated server-side
      // and unknown fields are rejected outright.
      const allowedKeys = new Set(["version", "browser", "browsers", "variables", "testUrl", "provider", "repository", "commitSha", "branch", "tag", "workflow", "workflowRunId", "pullRequestNumber"]);
      for (const key of Object.keys(body)) {
        if (!allowedKeys.has(key)) throw new AppError("INVALID_INPUT", { message: `Unknown parameter "${key}".` });
      }

      let version: number | undefined;
      if (body.version !== undefined) {
        if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 1 || body.version > test.current_version) {
          throw new AppError("INVALID_INPUT", { message: `version must be an integer between 1 and ${test.current_version}.` });
        }
        version = body.version;
      }

      let browsers: BrowserId[] = [];
      if (body.browsers !== undefined) {
        if (!Array.isArray(body.browsers) || body.browsers.length === 0) throw new AppError("INVALID_INPUT", { message: "browsers must be a non-empty array." });
        for (const browser of body.browsers) {
          if (!isBrowserId(browser)) throw new AppError("INVALID_INPUT", { message: `Unsupported browser "${String(browser)}".` });
        }
        browsers = [...new Set(body.browsers)] as BrowserId[];
      } else if (body.browser !== undefined) {
        if (!isBrowserId(body.browser)) throw new AppError("INVALID_INPUT", { message: `Unsupported browser "${String(body.browser)}".` });
        browsers = [body.browser];
      }

      let variables: Record<string, unknown> | undefined;
      if (body.variables !== undefined) {
        if (typeof body.variables !== "object" || body.variables === null || Array.isArray(body.variables)) {
          throw new AppError("INVALID_INPUT", { message: "variables must be an object." });
        }
        const entries = Object.entries(body.variables);
        if (entries.length > MAX_VARIABLES) throw new AppError("INVALID_INPUT", { message: `At most ${MAX_VARIABLES} variables per run.` });
        for (const [name, value] of entries) {
          if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new AppError("INVALID_INPUT", { message: `Invalid variable name "${name}".` });
          if (typeof value === "string" && value.length > MAX_VARIABLE_VALUE) throw new AppError("INVALID_INPUT", { message: `Variable "${name}" is too long.` });
          if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            throw new AppError("INVALID_INPUT", { message: `Variable "${name}" must be a string, number or boolean.` });
          }
        }
        variables = body.variables as Record<string, unknown>;
      }

      let testUrl: string | undefined;
      if (body.testUrl !== undefined) {
        if (typeof body.testUrl !== "string" || body.testUrl.length > 2048) throw new AppError("INVALID_INPUT", { message: "testUrl must be a bounded string." });
        testUrl = body.testUrl.trim() === "" ? undefined : body.testUrl.trim();
      }

      // Phase 16: bounded CI metadata validation (never arbitrary payloads).
      function boundedString(val: unknown, max = 256): string | undefined {
        if (val === undefined || val === null) return undefined;
        if (typeof val !== "string") throw new AppError("INVALID_INPUT", { message: "CI metadata fields must be strings." });
        const s = val.trim();
        if (s.length === 0) return undefined;
        if (s.length > max) throw new AppError("INVALID_INPUT", { message: "CI metadata value too long." });
        return s;
      }
      const ciMetadata = {
        provider: boundedString(body.provider, 64),
        repository: boundedString(body.repository, 256),
        commitSha: boundedString(body.commitSha, 40),
        branch: boundedString(body.branch, 128),
        tag: boundedString(body.tag, 128),
        workflow: boundedString(body.workflow, 256),
        workflowRunId: boundedString(body.workflowRunId, 64),
        pullRequestNumber: (typeof body.pullRequestNumber === "number" && Number.isInteger(body.pullRequestNumber) && body.pullRequestNumber > 0) ? body.pullRequestNumber : undefined,
      };

      const idempotencyKey = request.headers.get("idempotency-key");
      const fingerprint = `${apiContext.principal.organizationId}:${testId}:${version ?? "current"}:${browsers.join(",")}:${testUrl ?? ""}:${JSON.stringify(variables ?? {})}:${JSON.stringify(ciMetadata)}`;

      const result = await withIdempotency(
        { type: "organization", id: apiContext.principal.organizationId },
        idempotencyKey,
        `POST /api/v1/tests/${testId}/runs`,
        fingerprint,
        async () => {
          const suiteRow = getDb().prepare("SELECT id FROM saved_test_suites WHERE id = ? AND organization_id = ?").get(testId, apiContext.principal.organizationId);
          const suiteResult = suiteRow !== undefined ? await runStudioSuite(viewer, testId, { source: "ci", ...(testUrl ? { testUrl } : {}), ciMetadata }) : null;
          const matrixResult =
            suiteResult === null && browsers.length > 1
              ? await runStudioTestMatrix(viewer, testId, { source: "ci", browsers, ...(version ? { version } : {}), ...(testUrl ? { testUrl } : {}), ...(variables ? { variables } : {}), ciMetadata })
              : null;
          const singleResult =
            suiteResult === null && matrixResult === null
              ? await runStudioTest(viewer, testId, {
                  source: "ci",
                  ...(version ? { version } : {}),
                  ...(browsers.length === 1 ? { browserId: browsers[0] } : {}),
                  ...(testUrl ? { testUrl } : {}),
                  ...(variables ? { variables } : {}),
                  ciMetadata,
                })
              : null;
          const created =
            suiteResult ??
            (matrixResult
              ? { runId: matrixResult.runs[0].runId, jobId: matrixResult.runs[0].jobId, runs: matrixResult.runs }
              : singleResult!);
          recordAuditEvent({
            organizationId: apiContext.principal.organizationId,
            actorUserId: apiContext.principal.apiKey.created_by,
            actorApiKeyId: apiContext.principal.apiKey.id,
            action: "ci_run_requested",
            resourceType: "saved_test",
            resourceId: testId,
            requestId: apiContext.requestId,
            ip: apiContext.ip,
            metadata: { runId: created.runId, version: version ?? "current", browsers: browsers.length > 0 ? browsers.join(",") : "chromium" },
          });
          dispatchOrganizationEvent(apiContext.principal.organizationId, "test_run.created", { runId: created.runId, testId, organizationId: apiContext.principal.organizationId });
          const rows = browsers.length > 1 ? (created as { runs: Array<{ runId: string; jobId: string }> }).runs : [{ runId: created.runId, jobId: created.jobId }];
          return {
            status: 202,
            body: {
              runs: rows.map((row) => ({ id: row.runId, status: "QUEUED", jobId: row.jobId })),
              testId,
              poll: { intervalMs: 2000, path: `/api/v1/tests/${testId}/runs` },
            },
          };
        },
      );
      auditApiKeyUse(apiContext.principal, "ci_run_requested", null, apiContext.requestId, apiContext.ip, true);
      return NextResponse.json(result.body, { status: result.status });
    } catch (error) {
      auditApiKeyUse(apiContext.principal, "ci_run_requested", null, apiContext.requestId, apiContext.ip, false);
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ testId: string }> }): Promise<NextResponse> {
  const { testId } = await context.params;
  return withApiKey(request, { scope: "tests:read", rateClass: "read", action: "org:resources:read" }, async (apiContext) => {
    try {
      const viewer = studioViewer(apiContext);
      const test = getAccessibleSavedTest({ userId: viewer.userId, organizationId: viewer.organizationId }, testId);
      if (!test) throw new AppError("NOT_FOUND", { message: "Test not found." });
      const url = new URL(request.url);
      const page = Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);
      const listed = listTestRuns(viewer.userId, { page, limit, savedTestId: testId });
      return NextResponse.json({
        runs: listed.items.map(ciRunView),
        pagination: { page, limit, total: listed.total },
      });
    } catch (error) {
      return apiErrorResponse(error, apiContext.requestId);
    }
  });
}
