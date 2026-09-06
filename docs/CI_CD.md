# CI/CD integration

Run your saved Test Automation Studio tests from any CI system through the
**existing** ExtensionLab public API — the same API keys, scopes, rate
limits, quotas and entitlements as everywhere else. There is no separate
authentication, queue or execution path: a CI run is a normal queued run.

## Setup

1. Create an organization API key with the `tests:write` scope (Dashboard →
   Organization → API keys). Keys are organization-scoped; the plan of the
   key creator and the organization applies — CI never bypasses limits.
2. Save the key as a **secret** in your CI system. Never commit it.
3. Make sure the saved test is `ACTIVE` (CI refuses DRAFT/ARCHIVED tests) and
   that its extension package is uploaded (see “Package upload” below).

## Trigger a run

```bash
curl -X POST "$EXTENSIONLAB_URL/api/v1/tests/$TEST_ID/runs" \
  -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \
  -H "Idempotency-Key: build-$BUILD_ID" \
  -H "Content-Type: application/json" \
  -d '{"browser":"chromium"}'
```

Safe parameters (everything else is rejected; all validated server-side):

| Parameter | Meaning |
| --- | --- |
| `version` | exact saved-test version to run (default: current) |
| `browser` | one of `chromium`, `edge`, `firefox` (must be a target of the test) |
| `browsers` | array → independent per-browser runs (matrix; entitlement-gated) |
| `variables` | values for the test's typed variables (validated per type) |
| `testUrl` | bounded target page URL |

Always send an `Idempotency-Key` (e.g. the build id): retried pipelines then
replay the same run instead of double-charging quota.

## Poll until terminal

```bash
curl "$EXTENSIONLAB_URL/api/v1/tests/$TEST_ID/runs/$RUN_ID" \
  -H "Authorization: Bearer $EXTENSIONLAB_API_KEY"
```

Statuses: `QUEUED`, `STARTING`, `RUNNING`, `COMPLETED`, `FAILED`, `TIMEOUT`,
`CANCELLED`. Polling is sufficient — no SSE/websocket required.

**Exit semantics:** `exitCode` is `0` only when the run finished with a
passing/skipped/warning outcome. `FAILED`, `TIMEOUT`, `ERROR` and
infrastructure failures exit non-zero; `CANCELLED` exits `130`. The platform
never reports success when a worker could not actually execute the test.

## Webhooks (optional)

Subscribe an organization webhook to the existing `test_run.created`,
`test_run.completed` and `test_run.failed` events. Payloads are metadata
only and signatures use the existing webhook signing scheme
(`docs/WEBHOOKS.md`).

## Package upload

Runs execute the **exact package bytes** the test was saved against
(SHA-256). To test a freshly built extension in CI, upload the new package
first and save a test for it, e.g.:

```bash
PACKAGE_ID=$(curl -s -X POST "$EXTENSIONLAB_URL/api/v1/packages" \
  -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \
  -F "file=@extension.zip" | jq -r '.package.id')
```

Re-uploading identical bytes is idempotent; a saved test refuses to run
against different bytes until you re-save it against the new package (no
silent substitution).

## Examples (placeholders only — never real keys)

### GitHub Actions

```yaml
name: extension-tests
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run ExtensionLab test
        env:
          EXTENSIONLAB_URL: ${{ secrets.EXTENSIONLAB_URL }}
          EXTENSIONLAB_API_KEY: ${{ secrets.EXTENSIONLAB_API_KEY }}
          TEST_ID: st_your_saved_test_id
        run: |
          RUN_ID=$(curl -s -X POST "$EXTENSIONLAB_URL/api/v1/tests/$TEST_ID/runs" \
            -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \
            -H "Idempotency-Key: build-$GITHUB_RUN_ID" \
            -H "Content-Type: application/json" \
            -d '{"browser":"chromium"}' | jq -r '.runs[0].id')
          for i in $(seq 1 60); do
            STATUS=$(curl -s "$EXTENSIONLAB_URL/api/v1/tests/$TEST_ID/runs/$RUN_ID" \
              -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" | jq -r '.run.status')
            case "$STATUS" in
              COMPLETED) echo "passed"; exit 0 ;;
              FAILED|TIMEOUT|CANCELLED) echo "test $STATUS"; exit 1 ;;
            esac
            sleep 5
          done
          echo "timed out waiting for the run"; exit 1
```

### GitLab CI

```yaml
extension_tests:
  script:
    - RUN_ID=$(curl -s -X POST "$EXTENSIONLAB_URL/api/v1/tests/$TEST_ID/runs"
        -H "Authorization: Bearer $EXTENSIONLAB_API_KEY"
        -H "Idempotency-Key: build-$CI_PIPELINE_ID"
        -d '{"browser":"chromium"}' | jq -r '.runs[0].id')
    - |
      until STATUS=$(curl -s "$EXTENSIONLAB_URL/api/v1/tests/$TEST_ID/runs/$RUN_ID" -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" | jq -r '.run.status'); [ "$STATUS" = COMPLETED ]; do
        [ "$STATUS" = FAILED ] || [ "$STATUS" = TIMEOUT ] || [ "$STATUS" = CANCELLED ] && exit 1
        sleep 5
      done
  variables:
    EXTENSIONLAB_URL: $EXTENSIONLAB_URL       # group CI/CD variable
    EXTENSIONLAB_API_KEY: $EXTENSIONLAB_KEY   # masked group variable
```

### CircleCI

```yaml
jobs:
  extension-tests:
    docker: [{ image: cimg/base:stable }]
    steps:
      - run:
          name: Trigger + poll ExtensionLab
          command: |
            RUN_ID=$(curl -s -X POST "$EXTENSIONLAB_URL/api/v1/tests/$TEST_ID/runs" \
              -H "Authorization: Bearer $EXTENSIONLAB_API_KEY" \
              -H "Idempotency-Key: build-$CIRCLE_BUILD_NUM" \
              -d '{"browser":"chromium"}' | jq -r '.runs[0].id')
            # poll as in the GitHub Actions example
```

### Jenkins

```groovy
withCredentials([string(credentialsId: 'extensionlab-api-key', variable: 'KEY')]) {
  def runId = sh(script: """
    curl -s -X POST '$EXTENSIONLAB_URL/api/v1/tests/$TEST_ID/runs' \
      -H 'Authorization: Bearer $KEY' \
      -H 'Idempotency-Key: build-$BUILD_NUMBER' \
      -d '{"browser":"chromium"}' | jq -r '.runs[0].id'
  """, returnStdout: true).trim()
  // poll until terminal; fail the stage on FAILED/TIMEOUT/ERROR
}
```

### Plain shell

See the “Trigger a run” and “Poll until terminal” snippets — they are a
complete loop.

## Fairness

CI runs use the same fair queue as interactive sessions (Phase 13): jobs are
claimed per-user with bounded concurrency, and plans with priority execution
are claimed first. Heavy CI load cannot starve interactive users, and vice
versa.

## Troubleshooting

| Response | Meaning |
| --- | --- |
| 400 `…ACTIVE` | the test is a DRAFT — activate it first |
| 409 `SHA-256 mismatch` | the package changed; re-save the test against the new bytes |
| 403 scope | the key lacks `tests:write` |
| 404 | test/run not in this key's organization |
| 429 | rate limit or quota — reduce parallelism or upgrade the plan |
