# Worker Fleet (Phase 13)

How browser-testing work is executed by registered, supervised workers — and
how to operate them safely at multiple replicas.

Related: [SCALING.md](SCALING.md) (topology), [RUNTIME.md](RUNTIME.md)
(containers/images), [OPERATIONS.md](OPERATIONS.md) (runbooks),
[ARCHITECTURE.md](ARCHITECTURE.md) (component map).

## Lifecycle states

Workers register in PostgreSQL (`workers` table, migration 009) before claiming
jobs. State is **derived, never stored** — `classifyWorkerState` computes it
from the last heartbeat:

| State | Meaning | Derived when |
| --- | --- | --- |
| `STARTING` | Registered, no heartbeat yet | registered < 90 s ago, never seen |
| `READY` | Healthy, claiming work | heartbeat < 60 s old, not draining |
| `DRAINING` | Cooperative shutdown; finishes running jobs, claims nothing | `desired_state = drain` requested |
| `UNHEALTHY` | Missed heartbeats; jobs will be re-leased after their lease expires | heartbeat 60–300 s old |
| `STOPPED` | Gone; excluded from capacity math | heartbeat > 300 s old, or `desired_state = disable` |

Heartbeat cadence: every 15 s while running (and on each loop tick). A worker
that cannot write heartbeats fails loudly — it never keeps executing jobs
while appearing dead to the fleet.

## Graceful drain

`POST /api/admin/workers/{ref}/state` with `{"desired": "drain"}`:

1. The worker stops claiming new jobs on its next poll.
2. Running jobs run to completion (bounded by their lease/timeout).
3. Interactive sessions it owns are **not** killed — they expire/stop by the
   normal lifecycle; orphaned containers are reconciled by the sweep
   (see [RUNTIME.md](RUNTIME.md#orphan-reconciliation)).
4. When no jobs remain, the worker exits; its record shows `STOPPED` after the
   staleness window.

`{"desired": "disable"}` is the administrative kill: the worker stops claiming
immediately and its in-flight jobs are recovered by lease expiry (at-least-once
redelivery; handlers are idempotent).

## Fair scheduling

- Jobs are claimed oldest-first within a priority class, with per-organization
  fairness: no organization can monopolize workers while others wait (verified
  by `tests/phase13/fairness.test.ts` and the 100-job/10-org/4-worker load
  test in `tests/phase13/load.test.ts`).
- Per-org concurrency comes from the plan entitlement (server-side only).
- Cleanup jobs (artifact/interactive cleanup) always make progress.

## Capacity

- Runtime slots: global + per-org ceilings on concurrent interactive sessions
  (`INTERACTIVE_BROWSER_MAX_GLOBAL`, `INTERACTIVE_BROWSER_MAX_PER_ORG`).
- Slot claims are atomic (`claimStartSlot`) — the losing session stays `QUEUED`
  with no phantom slot (regression-tested in `tests/phase13/capacity.test.ts`).
- `GET /api/admin/capacity` reports queue depth, live sessions, slots in use
  and recent failures grouped by failure class.

## Idempotency & recovery

At-least-once delivery is the contract. Every handler is idempotent:

- **Interactive start**: a retry against a `READY`/terminal session is a no-op;
  a stale `STARTING` session has its leftover container removed and re-claims a
  slot (`tests/phase13/worker-recovery.test.ts`).
- **Stop/cleanup**: terminal states short-circuit; container removal is
  best-effort and reconciled by the sweep if it never ran.
- **Completion**: job completion writes are keyed by job id.

No auto-duplicates: a worker crash never silently starts a second browser for
the same session — the user sees an honest failed/stopped session and a
"Start New Session" action.
