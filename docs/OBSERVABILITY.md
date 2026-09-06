# Observability (Phase 13)

Correlation, structured logs, metrics, failure taxonomy and health endpoints.

Related: [OPERATIONS.md](OPERATIONS.md) (runbooks), [SCALING.md](SCALING.md).

## Correlation IDs

Every request/job/session carries identifiers that flow into every log line:

- `requestId` — per inbound API request (also returned as a response header)
- `jobId` — durable job identity across retries
- `sessionId` — interactive browser session
- `workerId` — the registered worker that claimed the job

Structured logs (`lib/observability/logger`) are JSON objects with a stable
`component` field. **Secrets are never logged**: runner tokens, session
secrets, API keys and authorization headers pass through the redaction
helpers (`lib/runtime/redact`) before any output.

## Metric registry

`lib/observability/metrics-registry.ts` — counters/timings with named
dimensions, no external dependency. Admin surface:
`GET /api/admin/metrics` returns the current snapshot (JSON). Key metrics:

| Metric | Meaning |
| --- | --- |
| `interactive.session_ready` | sessions that reached READY |
| `interactive.session_start_latency` | ms from queue to READY |
| `interactive.containers_reconciled` | orphans removed by the sweep |
| `interactive.frame_oversize` | frames rejected for size |

## Failure classes

`lib/observability/failure-class.ts` maps every catalog error code to one of
13 classes: `USER_ERROR`, `PACKAGE_ERROR`, `EXTENSION_ERROR`,
`BROWSER_ERROR`, `WORKER_ERROR`, `STORAGE_ERROR`, `QUEUE_ERROR`,
`INFRASTRUCTURE_ERROR`, `TIMEOUT`, `CANCELLED`, `QUOTA_EXCEEDED`
(incl. rate limits), `UNSUPPORTED`, `AUTH_ERROR`.

`GET /api/admin/failures` groups recent failed jobs by class (worst first) so
"the browser fleet is broken" vs "users upload broken packages" is one glance.

## Health vs readiness

- `/health` — liveness: is the process up? Cheap, no dependencies, strict
  timeouts; suitable for container restart probes.
- `/ready` — readiness: can this instance serve? Checks DB, storage provider
  (real write+delete for S3), coordination store ping — each with a bounded
  timeout, and reports `maintenanceMode` honestly. A not-ready instance is
  removed from rotation, not restarted.

## Admin surface (high-level only)

`/api/admin/workers`, `/workers/{ref}/state`, `/capacity`, `/failures`,
`/metrics`, `/reconcile` — read-heavy views plus two controlled actions
(drain/disable a worker; trigger an out-of-band reconcile). No shell, no
`docker exec`, no raw CDP, no arbitrary browser commands.
