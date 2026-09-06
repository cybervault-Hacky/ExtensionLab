# Browser Runtime Hardening (Phase 13)

The execution layer: versioned images, resource profiles, container
hardening, ownership labels, orphan reconciliation and the start circuit
breaker.

Related: [WORKERS.md](WORKERS.md), [SECURITY.md](SECURITY.md),
[INTERACTIVE_BROWSER.md](INTERACTIVE_BROWSER.md).

## Versioned browser images

- Production execution identity is an **image digest**, never a mutable
  `latest`. The digest actually started is recorded on the session
  (`browser_ready` event carries `imageRef` + `imageDigest`) and surfaced
  honestly; `unknown` means it could not be verified — it is never fabricated.
- `SANDBOX_IMAGE` pins the image; per-browser images follow
  `extensionlab-sandbox-<browser>:<version>`.
- Image health checks run before a container is declared ready (`/health` on
  the container-local control server, loopback only).

## Resource profiles

Two server-controlled profiles (Phase 13 §12/§62) — never client-selected:

| Profile | Memory | CPUs | PID limit | Who gets it |
| --- | --- | --- | --- | --- |
| `standard` | 768m | 0.5 | 200 | default |
| `heavy` | 1536m | 1.0 | 400 | plan entitlement `resourceProfile: "heavy"` |

Heavy only **tightens** limits on top of the same hardening baseline — it never
weakens it (`tests/phase13/hardening.test.ts`).

## Container hardening baseline (§13/§102)

Asserted verbatim against the `docker create` argument list:

- `--cap-drop ALL`, `--security-opt no-new-privileges`, never `--privileged`
- non-root user (`node`), `--read-only` rootfs, `--tmpfs /tmp:rw,noexec,nosuid`
- CPU/memory/PID limits always applied
- no host namespaces (`--network bridge`, no `--pid/--ipc/--uts=host`), no
  devices, no docker socket, no bind mounts
- control port published on `127.0.0.1` only

## Ownership labels

Every container is labeled:

```
extensionlab.sandbox=1
extensionlab.environment=<APP_ENV>
extensionlab.session=<sessionId>        # interactive sessions
extensionlab.worker=<workerRef>
extensionlab.browser=<browserId>
extensionlab.owner=interactive|test
```

## Orphan reconciliation

The interactive sweep (`lib/interactive/sweep.ts`, step 6) removes **only**
containers that carry this deployment's `extensionlab.environment` label,
`owner=interactive`, and are not bound to any live session's
`containerId`/`containerName`. Safety rules:

- containers younger than 3 minutes whose session is `CREATED`/`QUEUED`/
  `STARTING` are left alone (mid-start grace);
- containers of a **foreign environment** (another deployment sharing the
  Docker daemon) are never touched;
- `owner=test` sandboxes are managed in-process, not by this sweep.

Verified in `tests/phase13/reconcile.test.ts`.

## Circuit breaker

Per browser-kind breaker on container start failures
(`lib/runtime/breaker.ts`): `HEALTHY → DEGRADED → OPEN → RECOVERY → HEALTHY`.
Thresholds and cooldowns are env-configurable; `OPEN` fails fast with a
bounded retry hint and the session stays `QUEUED` (no slot consumed). One
failed recovery probe re-opens immediately; closing requires consecutive
successes. Semantics verified in `tests/phase13/breaker.test.ts`.
