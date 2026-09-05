import type { Metadata } from "next";

export const metadata: Metadata = { title: "ExtensionLab API documentation" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-600">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">{children}</pre>;
}

export default function ApiDocsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold text-slate-900">ExtensionLab public API</h1>
      <p className="mt-3 text-slate-600">
        A versioned HTTPS JSON API for analyzing browser extensions, running tests and browser matrices, and reading reports from CI. The public API is
        additive: internal endpoints used by the dashboard are not part of this contract.
      </p>

      <Section title="Authentication">
        <p>
          All requests authenticate with an organization API key: <code>Authorization: Bearer el_…</code>. Keys are created by organization admins, shown
          once, stored hashed, carry scopes and an expiry, and can be revoked instantly. Keys act with their creator&apos;s role — they never bypass plan,
          quota, entitlement or organization limits.
        </p>
      </Section>

      <Section title="Scopes">
        <p>
          Scopes follow <code>resource:read|write</code>: <code>packages</code>, <code>analysis</code>, <code>tests</code>, <code>reports</code>,{" "}
          <code>browser-matrix</code>, <code>webhooks</code>, <code>organization</code>. New keys default to the least-privilege read set. Requests outside
          a key&apos;s scopes fail with <code>API_SCOPE_DENIED</code> (403).
        </p>
      </Section>

      <Section title="Endpoints (v1)">
        <ul className="list-disc space-y-1 pl-5">
          <li><code>POST /api/v1/packages</code> — multipart <code>file</code> upload + static analysis (201, <code>packages:write</code>)</li>
          <li><code>GET /api/v1/packages/:id</code> — package metadata</li>
          <li><code>POST /api/v1/test-runs</code> — queue tests: <code>{"{ packageId, suiteId?, browsers?, testUrl? }"}</code>; one Chromium browser runs a single run, several browsers create a matrix (202)</li>
          <li><code>GET /api/v1/test-runs/:id</code> — run status and results</li>
          <li><code>GET /api/v1/browser-matrices</code> — list matrices (paginated)</li>
          <li><code>GET /api/v1/browser-matrices/:id</code> — matrix view, comparison and the deterministic CI gate verdict</li>
          <li><code>GET /api/v1/reports/:id</code> — sanitized report view</li>
          <li><code>GET /api/v1/jobs/:id</code> — job status</li>
          <li><code>GET /api/v1/organization</code> — organization, seats, entitlements, key info</li>
        </ul>
      </Section>

      <Section title="Idempotency">
        <p>
          Send <code>Idempotency-Key</code> on <code>POST</code> endpoints that create work. Keys are scoped to the organization: the same key with a
          different body returns <code>IDEMPOTENCY_CONFLICT</code> (409); the same key and body replays the original response. In-flight keys conflict
          until completion. Records expire after 24 hours.
        </p>
      </Section>

      <Section title="Rate limiting">
        <p>
          Limits apply per key, per organization and per endpoint class (read, upload, test, matrix, report) and are separate from plan quotas. Responses
          carry <code>x-ratelimit-limit</code>, <code>x-ratelimit-remaining</code>, <code>x-ratelimit-reset</code> and, when exceeded,{" "}
          <code>Retry-After</code> with <code>RATE_LIMITED</code> (429).
        </p>
      </Section>

      <Section title="Errors">
        <p>Every error uses one envelope — no stack traces, paths or SQL ever leak:</p>
        <Code>{`{
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource not found.",
    "requestId": "req_ab12cd34"
  }
}`}</Code>
        <p>
          Cross-organization access is indistinguishable from a missing resource (404). <code>requestId</code> matches the{" "}
          <code>x-request-id</code> response header for support.
        </p>
      </Section>

      <Section title="Webhooks">
        <p>
          Organizations can register HTTPS webhooks for events (<code>package.created</code>, <code>analysis.completed/failed</code>,{" "}
          <code>test_run.*</code>, <code>browser_matrix.*</code>, <code>regression.detected</code>, <code>report.created</code>,{" "}
          <code>member.joined</code>, <code>export.*</code>). Each delivery is signed:
        </p>
        <Code>{`X-ExtensionLab-Signature: t=1698765432,e=evt_…,v1=<hex hmac-sha256>
signed payload: "<timestamp>.<eventId>.<body>"`}</Code>
        <p>
          Verify the signature, reject timestamps outside your tolerance (replay protection), and respond 2xx quickly. Failed deliveries retry with
          exponential backoff up to a configured maximum, then dead-letter; delivery history is visible in the dashboard.
        </p>
      </Section>

      <Section title="CI/CD gate">
        <p>
          Organizations define quality gates (minimum health score, maximum critical/high findings, required tests and browsers, regression gate). The
          verdict comes back server-computed on <code>GET /api/v1/browser-matrices/:id</code> as <code>PASS</code>, <code>FAIL</code> or{" "}
          <code>NOT_EVALUATED</code>. Infrastructure failures are never reported as PASS.
        </p>
      </Section>

      <Section title="Examples">
        <p>GitHub Actions:</p>
        <Code>{`name: extension-quality
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Upload & analyze
        run: |
          curl -sf -X POST "$BASE_URL/api/v1/packages" \\
            -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \\
            -H "Idempotency-Key: \${{ github.sha }}" \\
            -F "file=@extension.zip" | tee analyze.json
      - name: Run browser matrix
        run: |
          curl -sf -X POST "$BASE_URL/api/v1/test-runs" \\
            -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \\
            -H "Idempotency-Key: \${{ github.sha }}-matrix" \\
            -H "content-type: application/json" \\
            -d '{"packageId":"'"$(jq -r .package.id analyze.json)"'","browsers":["chromium","edge","firefox"]}'`}</Code>
        <p>
          GitLab CI and Jenkins use the same two calls in <code>script:</code>/<code>sh</code> steps. Poll <code>GET /api/v1/browser-matrices/:id</code>{" "}
          until terminal and gate the pipeline on <code>policy.verdict</code>. A minimal CLI/SDK contract is the same request/response pair, so wrapping
          them in any language is straightforward.
        </p>
      </Section>

      <Section title="Versioning">
        <p>
          <code>/api/v1</code> is covered by additive-only compatibility: fields may be added, never removed or repurposed within a version. Breaking
          changes ship as <code>/api/v2</code> with a migration window.
        </p>
      </Section>
    </main>
  );
}
