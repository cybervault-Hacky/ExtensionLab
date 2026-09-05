# AI assistance (Phase 8)

Phase 8 adds an optional AI assistance layer on top of the deterministic
platform built in Phases 1–7. The static analyzer, the sandbox runtime, the
test engine, ownership checks and billing remain the authority for every
result ExtensionLab shows. AI only *explains* evidence those systems already
produced; it never generates evidence, never changes a score, never executes
anything and never decides who may see what.

```text
finding / test / run / report  ──►  context builder (allowlist + redaction)
                                      │
                                      ▼
                     AIService: prompt → provider → strict JSON validation
                                      │
                                      ▼
            "AI interpretation" panel next to the "Verified by ExtensionLab" data
```

## Contents

1. [Architecture](#architecture)
2. [Provider abstraction](#provider-abstraction)
3. [Configuration](#configuration)
4. [Features and API](#features-and-api)
5. [Context building and data minimization](#context-building-and-data-minimization)
6. [Redaction](#redaction)
7. [Prompt-injection defense](#prompt-injection-defense)
8. [Output validation and evidence linking](#output-validation-and-evidence-linking)
9. [Test suggestions](#test-suggestions)
10. [Quotas, rate limits and concurrency](#quotas-rate-limits-and-concurrency)
11. [Persistence, retention and deletion](#persistence-retention-and-deletion)
12. [Logging and metrics](#logging-and-metrics)
13. [Failure behaviour](#failure-behaviour)
14. [UI](#ui)
15. [Fake provider and testing](#fake-provider-and-testing)
16. [Production setup](#production-setup)
17. [Privacy summary](#privacy-summary)

## Architecture

Everything lives in `lib/ai/`; routes and components are thin.

| Module | Responsibility |
| --- | --- |
| `types.ts` | Feature names, `AIProvider` interface, context shape, output schemas (`explanation`, `summary`, `test_suggestions`, `answer`), `AIEvidenceRef`, `AI_DISCLAIMER` |
| `config.ts` | `getAISettings()` – validated view of `config.ai` (no key) |
| `provider.ts` | Provider registry: `isAIEnabled`, `getAIProvider`, `setAIProviderForTests`. Production never falls back to the fake provider |
| `providers/openai.ts` | OpenAI-compatible chat-completions adapter (any `AI_BASE_URL`) |
| `providers/fake.ts` | Deterministic `FakeAIProvider` with scripted failure scenarios |
| `sources.ts` | Owner-scoped loaders: `loadReportSource`, `loadTestRunSource`, `loadSnapshotSource` (all via `getOwned*`) |
| `context.ts` | `buildContext(source, {feature, maxBytes, focus})` – allowlisted, redacted, size-bounded evidence + `evidenceIndex`; `contextHash` |
| `redaction.ts` | `redactForAI`, `redactUrlForAI`, `redactDeep`, `looksLikeSecret` |
| `prompts.ts` | Central system rules, per-feature task text and JSON output schema; data always inside `<EXTENSIONLAB_DATA>` |
| `schema.ts` | Strict output validation (`validateOutput`), evidence filtering, output redaction |
| `test-suggestions.ts` | Server-side validation of every generated test against the Phase 4 engine allowlists |
| `limits.ts` | Global/per-user concurrency slots, bounded JSON body reader |
| `usage.ts` | Aggregate accounting (`recordAIRequest`) → logs + metrics, never content |
| `service.ts` | `runAIFeature(request)` – the only place that talks to a provider |
| `route-handler.ts` | `createAIRoute(spec)` – shared pipeline for all `/api/ai/*` routes |

Request pipeline (`route-handler.ts` → `service.ts`):

```text
same-origin → session (401) → per-user AI rate limit (429 AI_RATE_LIMITED)
→ provider configured? (503 AI_NOT_CONFIGURED) → plan allows AI? (402 PAYMENT_REQUIRED)
→ bounded JSON body (413) → owner-scoped resource load (404 AI_UNAUTHORIZED_CONTEXT)
→ buildContext (413 AI_CONTEXT_TOO_LARGE) → cache lookup (hit: no charge)
→ reserve AI quota (429 AI_QUOTA_EXCEEDED) → concurrency slot (503 AI_UNAVAILABLE)
→ prompt → provider call with timeout (504 / 502 / 429)
→ strict JSON validation (502 AI_INVALID_OUTPUT) → consume reservation → store result → 200
```

Every failure after the reservation releases it: users are charged only for
validated answers.

## Provider abstraction

```ts
interface AIProvider {
  readonly name: "openai" | "fake";
  readonly model: string;
  explainFinding(prompt, options): Promise<AIProviderResult>;
  explainTestFailure(prompt, options): Promise<AIProviderResult>;
  summarizeReport(prompt, options): Promise<AIProviderResult>;
  analyzeRuntimeError(prompt, options): Promise<AIProviderResult>;
  suggestTests(prompt, options): Promise<AIProviderResult>;
  answerReportQuestion(prompt, options): Promise<AIProviderResult>;
}
```

Providers receive an already-built prompt and return raw text plus token
counts; they never see repository objects, user ids or the database. The
OpenAI adapter posts one `chat/completions` request with
`response_format: json_object`, the API key only in the `Authorization`
header, an `AbortSignal` bound to `AI_TIMEOUT`, and reads at most
`AI_MAX_RESPONSE_BYTES`. Provider HTTP failures map to `AI_RATE_LIMITED`
(429), `AI_TIMEOUT` (408/504, abort), otherwise `AI_PROVIDER_ERROR`; nothing
from the provider body is forwarded to the client.

Adding another vendor means adding a file under `providers/` and one case in
`provider.ts`. Deliberately, only one production adapter ships.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `AI_PROVIDER` | `fake` (dev/test) / `disabled` (production) | `openai` \| `fake` \| `disabled`; `fake` is rejected in production |
| `AI_API_KEY` | – | required for `openai`; dropped from the config object for other providers; never in `describeConfig()` |
| `AI_MODEL` | `gpt-4o-mini` | validated charset |
| `AI_BASE_URL` | `https://api.openai.com/v1` | https in production; no credentials/query/fragment |
| `AI_TIMEOUT` | `20` s | `AI_TIMEOUT_MS` also accepted |
| `AI_MAX_REQUEST_BYTES` | 16 KiB | request body limit for `/api/ai/*` |
| `AI_MAX_CONTEXT_BYTES` | 24 KiB | sanitized evidence per request |
| `AI_MAX_OUTPUT_TOKENS` | 1200 | completion budget |
| `AI_MAX_RESPONSE_BYTES` | 64 KiB | provider response read limit |
| `AI_MAX_CONCURRENCY` / `AI_MAX_CONCURRENCY_PER_USER` | 4 / 1 | in-flight provider calls |
| `AI_RESULT_RETENTION_DAYS` | 30 | stored validated results; `0` disables reuse |
| `RATE_LIMIT_AI_PER_MIN` | 10 | per user + IP, independent of other limits |
| `PLAN_<PLAN>_AI_ENABLED`, `PLAN_<PLAN>_AI_LIMIT` | Free off/0, Pro 100, Business 500 | plan entitlements (see PLANS.md) |

Configuration validation fails closed: a production deployment with
`AI_PROVIDER=openai` and no key does not start; an unset `AI_PROVIDER` in
production simply disables AI. Readiness (`/api/ready`) reports
`capabilities.aiAssistance`, `/api/me` reports `ai.available`.

## Features and API

All routes: `POST`, session cookie required, same-origin enforced, JSON body,
success `200` with an `AIResponseEnvelope`:

```json
{
  "feature": "explain_finding",
  "result": { "kind": "explanation", "summary": "…", "whatItMeans": "…", "whyItMatters": "…",
              "likelyCauses": ["…"], "recommendations": ["…"],
              "evidence": [{ "kind": "finding", "id": "broad-host-access", "label": "Broad host access" }],
              "confidence": "medium", "caveats": ["…"] },
  "meta": { "provider": "openai", "model": "gpt-4o-mini", "cached": false, "durationMs": 1830,
            "createdAt": 1757000000000,
            "disclaimer": "AI-generated guidance is based on the available ExtensionLab evidence. Verify recommendations before applying changes." }
}
```

| Route | Body | Result kind | Purpose |
| --- | --- | --- | --- |
| `/api/ai/finding` | `{ reportId, findingId }` | `explanation` | Explain a static finding or runtime diagnostic of one of the caller's reports |
| `/api/ai/test-failure` | `{ runId, testId }` | `explanation` | Explain a failed / errored / timed-out test (runtime log and network summary artifacts are included when present) |
| `/api/ai/runtime-error` | `{ runId }` | `explanation` | Analyze captured runtime errors and failed requests of a run |
| `/api/ai/report-summary` | `{ reportId }` | `summary` | Headline, assessment, strengths, risks, priorities |
| `/api/ai/suggest-tests` | `{ reportId }` or `{ snapshotId }` | `test_suggestions` | Additional test cases, each validated server-side |
| `/api/ai/report-question` | `{ reportId, question }` (3–500 chars) | `answer` | Bounded Q&A about that report only; off-topic questions return `outOfScope: true` |

Public share tokens never reach these routes: they accept no token parameter
and `requireApiUser` demands a session. A stranger with a valid share link
gets `404` from every AI route (indistinguishable from a missing resource).

Errors use the platform envelope (`error.code`, `error.errorCode`,
`error.message`, `error.referenceId`, `x-request-id`):

| `errorCode` | HTTP | Meaning |
| --- | --- | --- |
| `AI_NOT_CONFIGURED` | 503 | No provider configured for this deployment |
| `PAYMENT_REQUIRED` | 402 | Plan does not include AI (details `{ reason: "plan", requiredPlan }`) |
| `AI_QUOTA_EXCEEDED` | 429 | Period allowance used (details `{ reason: "quota", kind: "ai_request", … }`) |
| `AI_RATE_LIMITED` | 429 | Per-user rate limit or provider rate limit |
| `AI_UNAUTHORIZED_CONTEXT` | 404 | Resource not owned / finding or test not part of it |
| `AI_CONTEXT_TOO_LARGE` | 413 | Even the minimal context exceeds `AI_MAX_CONTEXT_BYTES` |
| `AI_TIMEOUT` | 504 | Provider did not answer within `AI_TIMEOUT` |
| `AI_PROVIDER_ERROR` | 502 | Provider failure (retryable) |
| `AI_INVALID_OUTPUT` | 502 | Output failed schema validation (malformed, oversized, empty, wrong shape) |
| `AI_UNAVAILABLE` | 503 | Concurrency limit reached |

## Context building and data minimization

`buildContext` reads only allowlisted fields from the stored report / run /
snapshot JSON – never the uploaded package, file contents or the raw
manifest object:

- extension name, version, manifest version, declared permissions
  (name/kind/broad/reason), detected manifest features, file *paths* and count;
- scores and score categories;
- findings: id, source (`static`/`diagnostic`), severity, category, title,
  message, recommendation, evidence labels, related test id, source file path;
- tests: id, name, description, category, status, duration, steps, assertion
  outcomes, evidence labels/details, errors, warnings;
- run summary (outcome, counts, reason) and, for run-based features, the last
  runtime events (`evt-N`) and network entries (`net-N`) from the artifacts;
- the focus (finding id / test id / redacted question).

Excluded by construction: user id, e-mail, account, billing, session and
subscription data; the manifest `raw` object and `description`; file
contents; sandbox tokens or container information.

Each feature keeps what it needs and summarizes the rest (`explain_finding`
carries the focused finding plus its related test; `explain_test_failure`
keeps the focused test in full and summarizes the others; …). If the result
exceeds the byte budget, `fitToBudget` drops the least relevant material in
fixed order while always preserving the focused item, marks the context as
`truncated` (the prompt tells the model to lower confidence), and throws
`AI_CONTEXT_TOO_LARGE` only when nothing further can be dropped.

## Redaction

Every string that enters a context passes through `redactForAI`, which builds
on the Phase 3 runtime redaction and replaces with typed placeholders:
payment-provider keys (`sk_live_…`, `rk_…`, `pk_…`), webhook secrets
(`whsec_…`), OpenAI/GitHub/Slack/Google/AWS key shapes, JWTs, PEM blocks,
`Authorization`/`Cookie`/`x-api-key` headers, session/CSRF cookie values,
`SOMETHING_SECRET=value` and `password=…`/`token: "…"` assignments, e-mail
addresses and long opaque hex/base64 blobs. URLs additionally lose
credentials, fragments and sensitive query parameters. Object keys that look
like secrets (`redactDeep`) are replaced wholesale.

Redaction is applied again to every string in the validated model output, so
even a model that "quotes" a credential cannot return it to the browser.
`tests/phase8/ai-security.test.ts` asserts on the prompts the provider mock
actually received.

## Prompt-injection defense

Extension code, manifests, report data, console output and URLs are hostile
input. Defenses, in order:

1. Only allowlisted fields reach the prompt; free-text fields such as the
   manifest description never do.
2. All data is serialized as JSON inside a delimited `<EXTENSIONLAB_DATA>`
   block; task text and rules are outside it.
3. The central system prompt (`SYSTEM_RULES`, eight rules) states that the
   block is untrusted, that instructions inside it must never be followed,
   that no secrets/code/commands may be produced and that evidence must come
   from `ALLOWED_EVIDENCE`.
4. Output is data: strict schema validation, evidence filtering and
   re-redaction happen regardless of what the model "decided". The model has
   no tools, no network, no filesystem and no way to trigger actions.
5. Test suggestions are additionally validated against the test-engine
   allowlists (below) before they are shown.

## Output validation and evidence linking

Providers must return one JSON object. `validateOutput` parses it (rejecting
fenced or prose-wrapped text), checks the `kind`, required keys, string
length limits, array bounds, the `confidence` enum, and rejects unknown keys.
Every `evidence` entry must match an entry of the context's `evidenceIndex`
by *kind and id*; references to anything else are dropped, and the label is
replaced by the real one. The UI turns evidence chips into jump links
(`finding-<id>`, `diagnostic-<id>`, `test-<id>`, `section-<id>`) so a reader
can check the underlying deterministic data in one click.

Invalid output is never repaired or partially shown: the request fails with
`AI_INVALID_OUTPUT`, is not charged, and the client offers "Try again".

## Test suggestions

Generated tests are proposals, not executions. `validateSuggestedTest`
accepts a test only if it uses the Phase 4 allowlisted action and assertion
types (`open_url`, `wait`, `click`, `type`, `inspect_element`, `screenshot`,
`capture_*`, `wait_for_*`, `check_console`, … / `element_visible`,
`runtime_error_none`, `network_status_equals`, …) with no extra fields, safe
selectors (`validateSelector`), only the built-in test page or an `https`
URL passing `validateTestUrl` (no private/internal hosts, no `javascript:`,
`data:`, `file:`, `chrome:` schemes), values without executable or
command-like content, and the engine's limits (`MAX_ACTIONS_PER_TEST`,
`MAX_WAIT_MS`, `TEST_TIMEOUT`, at most 8 suggestions). Rejected candidates
are listed with a reason so the developer sees what was filtered. Running a
suggestion still goes through `POST /api/tests/create`, which re-validates
everything; the AI path grants no shortcut.

## Quotas, rate limits and concurrency

- **Plan entitlement** (`canUseAI` in `lib/billing/entitlements.ts`): Free
  plans have `aiEnabled=false` → `402` with the smallest plan that includes
  AI. No route or component compares plan ids.
- **Period quota** (`ai_request` usage kind): reserved by the service right
  before the provider call, consumed only after validation, released on any
  failure – the same reservation table as analyses and test runs, aligned
  with the billing period. Reading a stored result never charges.
- **Rate limit**: `RATE_LIMIT_AI_PER_MIN` per user+IP, a separate bucket from
  upload/test limits.
- **Concurrency**: `AI_MAX_CONCURRENCY` per process and
  `AI_MAX_CONCURRENCY_PER_USER`; excess returns `AI_UNAVAILABLE` immediately
  instead of queueing.
- **Sizes**: body, context, output tokens and response bytes are all bounded
  by configuration.

## Persistence, retention and deletion

Table `ai_results` (migration `004_phase8_ai.sql`) stores only *validated*
results: user id, feature, resource kind/id, target id, `context_hash`,
provider, model, `result_json`, token counts, duration, `created_at`,
`expires_at`. Prompts, raw provider responses and contexts are **not**
stored. A result is reused (`meta.cached: true`, shown as "Previously
generated") only for the same user, feature, resource, target and identical
sanitized context, so a new run or changed report never surfaces a stale
explanation. The cleanup job (`scope: "ai"`) deletes expired rows after
`AI_RESULT_RETENTION_DAYS`; the foreign key cascades on account deletion.
Ask-about-report answers are stored under the same rules (keyed by a hash of
the normalized question); no conversation history is kept.

## Logging and metrics

`recordAIRequest` emits one `ai.request` log event per attempt with
`requestId`, `userId`, `feature`, `provider`, `model`, `durationMs`,
`result` (`success` / `cached` / `timeout` / `provider_error` /
`rate_limited` / `quota_exceeded` / `plan_denied` / `invalid_output` /
`context_too_large` / `not_configured` / `unavailable` /
`unauthorized_context` / `invalid_input` / `error`), `errorCode` and token
counts. Metrics: `ai.request`, `ai.duration_ms`, `ai.tokens_input`,
`ai.tokens_output` plus one counter per outcome (`ai.success`,
`ai.cache_hit`, `ai.timeout`, `ai.provider_error`, `ai.rate_limited`,
`ai.quota_rejected`, `ai.plan_rejected`, `ai.invalid_output`,
`ai.context_too_large`, `ai.not_configured`, `ai.unavailable`,
`ai.unauthorized_context`), each tagged with `feature`, `provider`,
`result`. API keys, prompts, contexts, model output,
cookies and extension source never appear in logs (the shared logger also
redacts sensitive keys).

## Failure behaviour

| Situation | Result |
| --- | --- |
| `AI_PROVIDER=disabled` / missing | AI controls render "AI assistance is currently unavailable."; no route errors elsewhere; readiness still `ok`/`degraded` per core checks |
| Provider down, slow or rate-limiting | `502`/`504`/`429` with a reference id; UI shows "AI analysis is temporarily unavailable." with *Try again*; reports, runs and analyses are unaffected |
| Invalid model output | `AI_INVALID_OUTPUT`, no charge, no partial rendering |
| Plan/quota | `PaywallNotice` with *View plans*; previously generated results remain readable |
| Unexpected exception | Generic `500` envelope; nothing from the provider or the context is echoed |

AI panels are separate React components mounted next to deterministic
content; an AI error can never blank a report or a test-run page.

## UI

- Report detail: an **AI assistance** card (Generate AI summary, Suggest
  tests, Ask about this report) below Share, and an **Explain with AI**
  action on every finding and diagnostic row.
- Test run detail: **Analyze failure** inside expanded failed / error /
  timeout / warning rows and **Analyze runtime errors** under Diagnostics.
- Panels show an "AI-assisted" / "AI interpretation" badge, a confidence
  badge (high / medium / low, never a percentage), "Previously generated"
  when reused, evidence chips that jump to the referenced row, caveats and
  the fixed disclaimer. Deterministic cards carry a "Verified by
  ExtensionLab" badge so the two are never blurred.
- States: idle button → "Analyzing…" → result; "AI usage limit reached." /
  upgrade via `PaywallNotice`; "AI analysis is temporarily unavailable." with
  a reference id. Nothing runs on page load; every request is user-initiated.
- Public share pages have no session and render no AI controls or content.

## Fake provider and testing

`AI_PROVIDER=fake` (default outside production) activates
`createFakeAIProvider()`: it never makes network calls and derives a
plausible answer from the data block it receives, so it cites the *real*
finding/test ids of the report and exercises the full validation path.
Scenarios can be queued per call via `provider.fake.queue(...)`:
`success`, `timeout`, `provider_error`, `rate_limited`, `malformed_json`,
`empty`, `oversized`, `wrong_schema`, `invented_evidence`, `unsafe_tests`,
`injection_followed`. `fake.prompts()` exposes the prompts received for
assertions on redaction and injection handling.

`tests/phase8/`:

- `ai-provider.test.ts` – OpenAI adapter against a mocked `fetch` (headers,
  body, error mapping, timeout, empty/malformed/truncated/oversized
  responses), fake scenarios through the real service, cache reuse without
  charge, concurrency slots, metrics tags, `AI_NOT_CONFIGURED` with no
  fallback, determinism.
- `ai-security.test.ts` – redaction fixtures (fake API keys, bearer tokens,
  cookies, passwords, webhook secrets, e-mails), context allowlisting and
  minimization, focus preservation under truncation, injection fixtures in
  JS comments / HTML / console / URLs / CSS / manifest descriptions, output
  re-redaction, invented evidence filtering, production config validation,
  client-bundle hygiene.
- `ai-api.test.ts` – 401, same-origin, Free → 402, Pro → 200, input
  validation and 413, ownership (user A's report/run/snapshot rejected for
  user B, unknown finding/test ids), share tokens cannot enable AI, unsafe
  test suggestions rejected, all six routes, quota exhaustion → 429 with
  cached results still readable, Business allowance, provider failure not
  breaking report/test APIs, per-user rate limit, `AI_NOT_CONFIGURED` for
  every plan, retention cleanup, account deletion cascade, 401 after logout.

Manual smoke with the fake provider (development):

```bash
AI_PROVIDER=fake npm run dev
# 1. Sign in as a Free user: "Explain with AI" → 402 paywall with "View plans".
# 2. Upgrade with the fake billing provider (docs/BILLING.md) → Pro.
# 3. Explain a finding → explanation with evidence chips; a fixture secret in the
#    finding text appears as [REDACTED_…] in the prompt (see the test suite).
# 4. Suggest tests → only validated tests, rejected ones listed with reasons.
# 5. Analyze a failed test, generate a summary, ask a question, ask something
#    off-topic → outOfScope answer.
# 6. Exhaust PLAN_PRO_AI_LIMIT → 429 "AI usage limit reached."; reports and
#    test runs continue to work; log out → 401.
```

A real-provider end-to-end run requires `AI_PROVIDER=openai` and a key; it is
not part of the automated suite.

## Production setup

1. Decide whether to enable AI at all. Without `AI_PROVIDER` the platform
   runs exactly as in Phase 7.
2. Set `AI_PROVIDER=openai`, `AI_API_KEY`, optionally `AI_MODEL` and
   `AI_BASE_URL` (an OpenAI-compatible gateway is fine; https only). Store the
   key in the secret manager of the platform, never in images or the repo.
3. Review the budgets: `AI_TIMEOUT`, `AI_MAX_CONTEXT_BYTES`,
   `AI_MAX_OUTPUT_TOKENS`, `AI_MAX_CONCURRENCY`, `RATE_LIMIT_AI_PER_MIN`, the
   plan allowances (`PLAN_PRO_AI_LIMIT`, `PLAN_BUSINESS_AI_LIMIT`) and
   `AI_RESULT_RETENTION_DAYS` against the provider contract and the privacy
   policy shown to customers.
4. Allow outbound HTTPS from the web process to `AI_BASE_URL` only.
5. Run `npm run db:migrate` (adds `ai_results`) and confirm
   `/api/ready` → `capabilities.aiAssistance: true`.
6. Watch `ai.*` metrics and `ai.request` logs; rotate the key like any other
   credential (a restart picks up the new value).

## Privacy summary

- Sent to the provider: redacted, allowlisted analysis and test evidence of a
  resource the requesting user owns, plus the redacted question text.
- Never sent: account/e-mail/user ids, billing or session data, uploaded
  package contents, raw manifests, secrets, container or host information.
- Stored: validated results with provider/model metadata for
  `AI_RESULT_RETENTION_DAYS`; deleted with the account.
- Logged: aggregate request metadata only.
- Shown to users: every AI panel is labelled as AI interpretation, carries a
  confidence level and the disclaimer, and links back to the deterministic
  evidence it was derived from.
