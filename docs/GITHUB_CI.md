# GitHub CI/CD Integration (Phase 16)

ExtensionLab is integrated directly into modern developer CI/CD workflows via a reusable GitHub Action and the existing Public API.

## Core Principle

GitHub integration is a thin integration layer. Existing ExtensionLab systems remain authoritative: authentication, organization authorization, billing/entitlements, package upload, test engine, worker fleet, browser infrastructure, regression/baseline, and webhook infrastructure are all reused unchanged.

## Authentication

Use an ExtensionLab API key with the narrowest scopes required:

- `tests:read` / `tests:write`
- `packages:write`

Recommended: create a dedicated CI key rather than a personal key. Rotate by creating a new key, updating the GitHub secret, verifying the workflow, then revoking the old key.

Store the key as a repository secret:

- Repository Settings → Secrets and variables → Actions → New repository secret
- Name: `EXTENSIONLAB_API_KEY`

Never commit secrets. The action masks authorization headers and API keys in output.

## Action Usage

> Replace the action reference with your organization’s published ExtensionLab action once available.

```yaml
name: ExtensionLab

on:
  pull_request:
  push:
    branches: [main]

jobs:
  extensionlab:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build extension
        run: |
          # project-specific build command

      - name: ExtensionLab
        uses: YOUR_ORG/extensionlab-action@v1
        with:
          api-key: ${{ secrets.EXTENSIONLAB_API_KEY }}
          test-id: YOUR_TEST_ID
          package: dist/extension.zip
          browser: chromium
          matrix: false
          wait: true
          timeout: 15
          fail-on-regression: true
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| api-key | yes | — | ExtensionLab API key (secret) |
| test-id | yes | — | Saved test ID |
| package | yes | — | ZIP package path |
| browser | no | chromium | Target browser |
| matrix | no | false | Run all selected browsers |
| wait | no | true | Wait for result |
| timeout | no | 15 | Polling timeout (minutes, max 15) |
| fail-on-regression | no | true | Fail on regression detection |
| project-id | no | — | Metadata only |

## CI Metadata

When running from GitHub Actions, safe bounded metadata is sent with each run:

- `provider`: `github`
- `repository`: `owner/repo`
- `commitSha`: abbreviated safe hash
- `branch`: bounded string (e.g., `main`, `feature/foo`)
- `workflowRunId`: run identifier
- `pullRequestNumber`: validated integer (only when from `pull_request`)

Only metadata needed for CI traceability is included. No full GitHub payloads are stored.

## Outputs

- `run-id`: ExtensionLab run identifier
- `status`: PASS / FAIL / WARN / INFRASTRUCTURE_ERROR / AUTHENTICATION_ERROR / QUOTA_EXCEEDED
- `result-file`: Generated `extensionlab-results.json` artifact

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success (PASS) |
| 1 | Gate failed (test/regression/browser failure) |
| 2 | Configuration/authentication error |
| 3 | Infrastructure/API error |
| 4 | Timeout / cancellation |

Never return exit code 0 for an ExtensionLab failure.

## Package Integrity

The CI uploads the ZIP via the existing `/api/v1/packages` endpoint. The returned SHA-256 becomes the authoritative package identity. The subsequent test execution references the exact package through the test’s saved package binding (`package_sha256` verification). If the package has changed since the test was saved, the server returns `CONFLICT` — never silently substitutes a different package.

## Regression Gate

Policies are resolved server-side when possible. Explicit policies must be configured:

- `FAIL_ON_TEST_FAILURE`
- `FAIL_ON_REGRESSION`
- `FAIL_ON_PERFORMANCE_REGRESSION`
- `FAIL_ON_BROWSER_INCOMPATIBILITY`

The CI result is deterministic: `PASS` with counts, `FAIL` with reasons, or `WARN`. Example:

```
PASS
12 tests passed
0 regressions
```

```
FAIL
11 tests passed
1 new failure
```

## Browser Matrix

If `matrix: true`, the action submits all browsers selected by the test (`chromium`, `edge`, `firefox`). Each browser runs independently; the overall result is `FAIL` if any browser fails. Existing browser compatibility classification applies.

## JUnit / SARIF

When tests complete, results can be exported as JUnit XML (`extensionlab-results.xml`) and SARIF (`extensionlab-results.sarif`) using existing test result data and Phase 2 static-analysis findings. No fabricated data is produced.

## Security

- The action never stores GitHub tokens, repository passwords, or OAuth tokens.
- Secrets are masked in logs via `sanitize()`.
- Artifacts must not contain API keys, cookies, authorization headers, or raw private credentials.
- ExtensionLab executes only the uploaded package through its existing sandbox; it never executes GitHub build commands.

## Troubleshooting

- `401`: Verify `EXTENSIONLAB_API_KEY` scope includes `tests:write` / `packages:write`.
- `403`: API key lacks required scope or cross-org access attempted.
- `409`: Idempotency conflict — repeated workflow execution with same key; use deterministic idempotency keys.
- `429`: Rate limit exceeded; increase polling interval or reduce concurrent CI runs.
- `5xx`: Infrastructure error — never convert into test success.
- `TIMEOUT`: Check `timeout` input; worker/browser availability may be reduced.

## Setup Wizard

Visit `/dashboard/tests/ci/setup` to select a project and test, create a CI API key, copy a workflow snippet, and verify connection with a safe authenticated call (no browser test started).

## Key Rotation

1. Create new CI API key
2. Update GitHub secret (`EXTENSIONLAB_API_KEY`)
3. Verify workflow passes
4. Revoke old key

## Notes

- The action is repository-local; publish to the GitHub Marketplace requires separate packaging outside this repository.
- Use `v1` (or an immutable commit SHA) in workflows rather than mutable `main` branches for supply-chain security.
- Dependency checks and secret scanning should be run against `.github/actions/extensionlab/`, tests, fixtures, and generated artifacts.
