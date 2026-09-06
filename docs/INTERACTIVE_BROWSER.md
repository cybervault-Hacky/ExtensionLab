# Interactive Browser (Phase 11)

The Interactive Browser lets a user load **their own uploaded extension package**
into a disposable, isolated Chromium instance and interact with it from the web
UI — clicking, typing, scrolling, opening the extension popup, and watching the
console and network panels — while ExtensionLab guarantees that the exact
package that was uploaded is the one that runs, in a container that touches
nothing but its own sandboxed browser.

```
upload ZIP ──▶ browser-session (bound to package + SHA-256)
                    │
                    ▼  INTERACTIVE_BROWSER_START job (worker)
             Docker container (pinned sandbox image)
             Chromium + the extracted, hash-verified extension
                    │  controlled protocol only (loopback HTTP + token)
                    ▼
             frames / console / network / events ──▶ web UI (SSE + PNG frames)
```

This feature builds on the existing runtime — Phase 3 sandbox, Phase 6 job
queue, Phase 9 browser adapters. There is no second runtime, no second worker,
and no second billing system.

## Lifecycle

```
CREATED ─▶ QUEUED ─▶ STARTING ─▶ READY ─▶ ACTIVE ─⇄ IDLE ─▶ EXPIRED
                        │                                     ▲
                        └──────────────▶ FAILED ◀────────────┘
                                         (any state) ─▶ STOPPED
```

| State | Meaning |
| --- | --- |
| `CREATED` | Session row exists; bound to an exact package; quota reserved. |
| `QUEUED` | Start job enqueued; waiting for a runtime slot. |
| `STARTING` | A worker claimed the session; container/browser starting. |
| `READY` | Real Chromium is up **and the extension loaded** (evidence recorded). |
| `ACTIVE` | The user is interacting (input/navigation observed). |
| `IDLE` | No activity for the idle timeout; grace window before expiry. |
| `STOPPING` | Tearing down (container + extracted package removal). |
| `STOPPED` / `EXPIRED` / `FAILED` | Terminal. Every terminal row records a `stopReason`. |

Stop reasons: `user_stop`, `idle_timeout`, `max_lifetime`, `browser_crash`,
`start_failed`, `start_limit_exhausted`, `start_abandoned`, `cancelled`,
`package_unavailable`, `package_hash_mismatch`, `browser_start_failed`,
`stopped_by_user`.

## Exact package binding (no substitution, ever)

- A session stores `package_id`, `package_version`, and the package
  **SHA-256** at creation time. Ownership and entitlement are verified
  server-side (`user → project → org → package`).
- At `START` the worker re-reads the stored bytes and re-hashes them. A missing
  package fails the session (`package_unavailable`); a hash mismatch fails it
  (`package_hash_mismatch`). Nothing is ever substituted or re-resolved.
- **Reload Extension** re-verifies the same binding; if the package is gone the
  session fails closed and is destroyed.
- Extension panel facts (popup path, service worker, content scripts,
  permissions) are derived from the extracted `manifest.json` of the verified
  package — never from client input.

## Security model

The uploaded extension is **untrusted code running inside a disposable
container**. The boundaries:

1. **No raw browser channels.** No CDP, no shell, no `Runtime.evaluate`, no
   Chromium flags, no Docker socket, no host mounts, no privileged or
   host-network containers. The container exposes exactly one loopback HTTP
   control port guarded by a per-session token (the Phase 3 runner protocol).
2. **Typed, allowlisted input.** The web client can send only:
   `pointer_move`, `pointer_down`, `pointer_up`, `click`, `double_click`,
   `type_text`, `key_press`, `scroll` — with viewport-bounded coordinates,
   bounded text (2 000 chars), an allowlisted key set, bounded scroll deltas
   (±3 000), an 8 KB payload cap, and a per-session action rate limit. The
   runner validates the same schema again inside the container: two independent
   allowlists with no generic passthrough between them.
3. **URL policy = the existing SSRF guard.** Navigation reuses the Phase 3
   validator: only `https:` (plus `http:` when explicitly enabled), no
   credentials, `file:`/`javascript:`/`data:`/`chrome:`/`devtools:`/
   `view-source:` blocked, literal private/loopback/link-local hosts blocked,
   and DNS resolution pinned against rebinding to private ranges.
4. **Frames, not video.** The only way to see the browser is rate-limited PNG
   frame captures (`GET /api/browser-sessions/{id}/screenshot`), served with
   `private, no-store`, `nosniff`, and `default-src 'none'; sandbox`. The popup
   renders **inside the container**; popup HTML is never extracted into the web
   app. No VNC, no websocket, no exposed container ports.
5. **Tenant isolation.** Every route resolves `user → owned session`; anything
   else is a plain 404. Session views never contain runtime internals
   (container ids, ports, tokens, temp paths) — verified by a regression test.
6. **Hard time limits.** `expiresAt` is fixed at creation and no keepalive can
   extend it. Idle sessions go `ACTIVE/READY → IDLE → EXPIRED` with a visible
   reason; the sweeper destroys container + extracted package on every path.

## API

All routes require an authenticated, same-origin caller; cross-tenant access
returns 404.

| Route | Purpose |
| --- | --- |
| `POST /api/browser-sessions` | Create a session bound to a `packageId` (optional `initialUrl`, `viewport`). |
| `GET /api/browser-sessions` | List my recent sessions (reconnection support). |
| `GET /api/browser-sessions/{id}` | Current session view. |
| `POST /api/browser-sessions/{id}/start` | Enqueue the start job. |
| `POST /api/browser-sessions/{id}/stop` | Stop and tear down (idempotent). |
| `POST /api/browser-sessions/{id}/navigate` | `{op: navigate\|back\|forward\|reload}` through the SSRF guard. |
| `POST /api/browser-sessions/{id}/input` | One typed input action. |
| `POST /api/browser-sessions/{id}/popup` / `DELETE …/popup` | Open/close the extension popup in-container. |
| `POST /api/browser-sessions/{id}/extension/reload` | Re-verify binding and restart the extension. |
| `GET /api/browser-sessions/{id}/events` | Durable events (after `seq`). |
| `GET /api/browser-sessions/{id}/events/stream` | SSE: `state`, `console`, `network`, `events`, live frames. |
| `GET /api/browser-sessions/{id}/screenshot` | Latest PNG frame (`?target=page\|popup`). |
| `POST /api/browser-sessions/{id}/screenshot` | Capture a retained screenshot artifact. |
| `GET /api/browser-sessions/{id}/artifacts` / `…/{artifactId}` | Screenshot artifacts (retention-managed). |
| `GET /api/browser-sessions/{id}/console` / `…/network` | Bounded ring snapshots. |
| `POST /api/browser-sessions/{id}/viewport` | Resize within deployment bounds. |
| `POST /api/browser-sessions/{id}/keepalive` | Rate-limited activity touch (never extends `expiresAt`). |

Billing gates reuse the Phase 7 entitlements exactly: a plan without the
feature returns the standard 402 envelope; an exhausted per-period session
quota returns 429 `QUOTA_EXCEEDED`; concurrency produces retryable queue
backpressure (the session stays `QUEUED` and the job retries with backoff).

Operator surface: `GET /api/admin` exposes session counts by status and
`GET /api/admin/browser-sessions` lists admitted + recently finished sessions
with stop reasons — read-only, token-gated, fail-closed 404 when disabled, and
free of runtime internals.

## Jobs and recovery

- `INTERACTIVE_BROWSER_START` — verifies the package, claims a runtime slot
  (global / per-org / per-user), extracts the ZIP to a 0700 temp dir, creates
  the container, starts Chromium, and requires **real extension-load
  evidence** before `READY`. Capacity errors are retryable
  (`BROWSER_SESSION_LIMIT`); Docker-unavailable is retryable; integrity
  failures are terminal. Idempotency key `ibrowser-start:{sessionId}`.
- `INTERACTIVE_BROWSER_STOP` — idempotent teardown; releases an unconsumed
  quota reservation when a session never started.
- `INTERACTIVE_BROWSER_CLEANUP` — scheduled sweeper (Phase 6 orphan-recovery
  pattern): max-lifetime expiry, idle transitions, dead-container detection
  (`browser_crash`), stale `STARTING` recovery (`start_abandoned`), expired
  artifact pruning. Runs on the same idempotency-keyed interval windows as the
  other Phase 6 cleanups.

Every termination path removes the container **and** the extracted package
directory; the e2e suite asserts no sandbox container survives a test.

## Browsers

Chromium is fully supported today (the pinned sandbox image). Edge and Firefox
will follow in the supported runtime (Phase 9 adapters); until then the UI
offers only Chromium rather than pretending otherwise.

## Testing

- `tests/phase11/` — lifecycle, input model, URL policy, popup/streams,
  API authorization + leak regression, quotas/capacity/recovery, and a
  deterministic load test with simulated workers (oversubscribed queue,
  backpressure, no cap violations, no leaks). The fake runtime is a **real
  in-process HTTP server** speaking the runner protocol, so the handler,
  hub, and control-client code paths are the production ones.
- `tests/e2e/interactive-browser.e2e.test.ts` — real-Docker end-to-end with a
  deterministic fixture extension (manifest + popup + content script + service
  worker + console events). Skips with an explicit reason when Docker or the
  sandbox image is missing; `EXTENSIONLAB_E2E_DOCKER=1` makes unavailability
  a hard failure. Results are never faked.

## Configuration

See `.env.example` (`INTERACTIVE_BROWSER_*`, `PLAN_*_INTERACTIVE_*`) for every
knob: feature flag, global/per-org caps, per-plan concurrency/minutes/sessions,
idle timeout + grace, frame interval and byte caps, artifact caps, input and
keepalive rates, viewport bounds, and ring sizes.
