# Horizontal Scaling (Phase 13)

ExtensionLab's path from one box to a fleet — what scales horizontally today,
what pins a deployment to a single writer, and how the pieces coordinate.

Related: [WORKERS.md](WORKERS.md), [DEPLOYMENT.md](DEPLOYMENT.md),
[OBSERVABILITY.md](OBSERVABILITY.md).

## Topology

```
            ┌────────────┐
 visitors ──┤  web  × N  ├── SSE live frames ──┐
            └─────┬──────┘                     │ coordination store
                  │                            │ (Redis, pub/sub + limits)
            ┌─────▼────────────────────────────▼─────┐
            │        PostgreSQL / SQLite             │  ← source of truth
            └─────▲───────────────────────────────────┘
                  │ claim/lease
            ┌─────┴──────┐
            │ worker × M │── Docker socket (workers only) ──> sandbox containers
            └────────────┘
```

- **The database is the source of truth** for jobs, sessions, slots and
  entitlements. Redis (via `lib/coordination`) is a coordination layer only:
  distributed rate limits, advisory locks with TTL+renewal semantics, and
  best-effort SSE frame pub/sub. Losing Redis degrades those three features
  loudly; it never changes what a user is allowed to do.
- Web instances are stateless (sessions in DB/cookie). SSE works from any
  instance: frames the owning instance publishes are fanned out over the
  coordination bus (`interactive:frames:<sessionId>`), with echo suppression;
  replay on reconnect is always DB-based.
- Workers require the Docker socket; web never gets it.

## What is horizontally safe today

| Concern | Mechanism |
| --- | --- |
| Job claiming | atomic claim + lease in the DB; at-least-once delivery, idempotent handlers |
| Interactive capacity | atomic slot claims (`claimStartSlot`) — exactly one winner |
| Rate limits / abuse | coordination store counters (identical memory/Redis behavior) |
| SSE across instances | coordination pub/sub bridge in the session hub |
| Maintenance/kill switch | DB/config-backed gates evaluated per request |
| Orphaned containers | label-scoped reconciliation sweep (any instance can run it) |
| Migrations | runner holds the DB write lock (`BEGIN IMMEDIATE`) for the whole run |

## Single-writer constraints (honest limits)

- This build ships the **SQLite driver only**. SQLite on a shared volume
  supports exactly one writer process at a time (WAL + `busy_timeout=5000`
  serialize access). For multiple concurrent web/worker processes, front the
  deployment so that **one web + one worker process pair** owns the volume, or
  wait for the PostgreSQL driver (the platform fails closed rather than
  silently degrading — see `docs/DEPLOYMENT.md`).
- Worker replicas each need their own Docker socket access and unique
  `WORKER_ID`; the fleet registry deduplicates by hashed ref.

## Deterministic verification

- Fairness/no-starvation across orgs: `tests/phase13/fairness.test.ts`
- Load: 100 jobs / 10 orgs / 4 workers drained with bounded starvation and
  per-org caps: `tests/phase13/load.test.ts`
- Duplicate delivery / worker crash mid-start: `tests/phase13/worker-recovery.test.ts`
- Cross-instance SSE: `tests/phase13/sse-multi-instance.test.ts` (memory bus
  simulates two instances) and `tests/e2e/phase13-infra.e2e.test.ts`
  (`EXTENSIONLAB_E2E_REDIS=1` runs it against real Redis).

## Warm pools (optional, off by default)

Warm containers may pre-start **per worker, never shared across users**: a
warm container is assigned to exactly one session at first use and destroyed
with it — profile/data isolation is never reused. When enabled, the pool obeys
the same capacity slots and labels as cold starts. (Ships as a capability of
the driver layer; no deployment enables it by default.)
