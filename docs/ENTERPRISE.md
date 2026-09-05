# Enterprise: scale, governance and the public platform

Phase 10 turns the single-user pipeline of Phases 1–9 into a multi-tenant
platform without weakening a single existing control. Companion pages:
`docs/ORGANIZATIONS.md` (workspaces/RBAC/audit), `docs/API.md` +
`docs/API_KEYS.md` (public API), `docs/WEBHOOKS.md` (events),
`docs/SSO.md` (single sign-on).

## Scale architecture

| Concern | Development (default) | Production |
| --- | --- | --- |
| Database | SQLite file via the same repository layer | PostgreSQL via `DATABASE_URL` (driver enforced at startup; SQLite is rejected for production use) |
| Coordination (rate limits, locks) | In-memory store | Redis via `COORDINATION_PROVIDER=redis` + `REDIS_URL` |
| Workers | Embedded tick loop | Any number of independent worker processes claiming jobs atomically |
| Queue | `jobs` table with conditional `UPDATE … RETURNING` claims, leases, heartbeats, orphan recovery | Same, plus per-organization fairness |

All multi-worker behaviour flows through a small coordination abstraction
(`lib/coordination`) so local development needs no Redis. `redis` is loaded
lazily; a misconfigured production deployment fails at startup with a
descriptive error rather than silently degrading.

## Queue fairness & priorities

- `claimNextJob` scans a bounded window ordered by priority/age and picks the
  first candidate whose organization is below its concurrency cap
  (per-organization max concurrency from the entitlement service, globally
  clamped by `ORG_MAX_CONCURRENCY`). Jobs without an organization are always
  eligible, so a single tenant can flood the queue but never monopolize the
  fleet.
- Priority classes — `interactive` > `enterprise` > `ci` > `normal` — only
  reorder the queue. Priorities never bypass security checks, plan quotas,
  entitlements or organization limits, and raw priorities are clamped to
  ±100.

## Observability (unchanged contract, extended fields)

Structured logs carry request/job/organization/user ids, durations and
outcomes. Metrics cover HTTP, jobs (including queue latency and retries),
browser success vs. infrastructure failures, storage, billing denials, and
API/rate-limit/auth failures — all low-cardinality labels. Readiness checks
database, queue, storage and worker health for real (health ≠ readiness).

## Internal admin abstraction (config-gated)

An internal admin surface can inspect queue depth, worker health, retry or
cancel jobs. It is gated by configuration and strong authorization, and every
action is audited. It intentionally provides **no shell and no Docker
execution** path.

## Public platform (published reports)

Admins can publish a report to a public slug (`/extensions/:slug`), default
private. The public page renders a deliberately narrow projection: title,
summary, scores, browser outcomes, compatibility and provenance labels
("Verified by ExtensionLab" / "AI interpretation" / "User provided" /
"Infrastructure unavailable"). Organization identity, member identities,
source code, internal URLs, container ids and job data are never part of the
projection. Unpublishing removes the page immediately.

## CI/CD & enterprise reports

Reports produced for organizations carry organization context internally but
expose only sanitized views; AI-derived sections keep their provenance
labels. Deterministic, server-evaluated quality gates (see `docs/API.md`)
give CI a stable PASS|FAIL|NOT EVALUATED verdict — infrastructure failures
are never PASS.

## Data governance

- **Audit**: immutable, redacted, filterable, exportable (role-gated).
- **Retention**: org-aware cleanup — audit events per organization retention,
  expired exports, expired idempotency records and due webhook deliveries are
  swept by the same idempotent scheduler that never deletes across
  organizations.
- **Export**: async, audited, expiring, metadata-only (see
  `docs/ORGANIZATIONS.md`).

## Abuse protections

Upload size/count limits, per-user and per-org queue caps with backpressure,
rate limiting on every public surface (IP/user/org/key/class), bounded audit
search, one-active-export rule, invitation and webhook caps, and generic
errors that reveal nothing about other organizations. Pagination is
cursor/bounded everywhere; list endpoints are capped.

## Database indexes (migration 006)

Organization tables and the added `organization_id` columns are indexed for
the hot paths: org+created_at on audit/deliveries, key-hash lookup (unique),
webhook delivery state, job state + organization, package/run/matrix/report
organization lookups, invitation token hash (unique), publication slug
(unique). The migration is deterministic, transactional and FK-safe.

## Testing

`tests/phase10/` — 80 tests across organizations/RBAC/invitations, tenant
isolation, API keys, the public API surface (auth, scopes, rate limits,
idempotency, error envelope), webhooks (signing, SSRF, retries, states),
audit (redaction, filtering, scoping), policies (determinism + gate
integration), queue fairness (per-org caps, starvation freedom, priorities),
exports, security (publications projection, SSO masking, workspace cookie
validation, coordination, dispatch resilience).
