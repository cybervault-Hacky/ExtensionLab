# Webhooks

Organizations can receive signed HTTPS callbacks when meaningful events
happen. Webhooks require the `webhooks` entitlement (Pro+).

## Registration & validation

- **HTTPS only.** Plain HTTP, credentials-in-URL and non-HTTP schemes are
  rejected.
- **SSRF protection** at registration *and* at every delivery attempt:
  literal private/loopback/link-local/reserved IPv4 and IPv6 targets are
  blocked, and hostnames are resolved with all records checked — any A/AAAA
  answer in a private range (including `10/8`, `172.16/12`, `192.168/16`,
  `169.254/16` cloud metadata, carrier-grade NAT, `::1`, `fc00::/7`,
  `fe80::/10`) rejects the destination. This defeats DNS-rebinding-style
  tricks because the check runs against the same resolution used for delivery.
- Each webhook chooses 1–20 event types (or `*`).
- The signing secret (`whsec_…`) is shown **once** at creation and never
  stored in the clear anywhere user-visible afterwards.
- Per-organization webhook cap (`ORG_MAX_WEBHOOKS_PER_ORG`, default 10).

## Events

`package.created`, `analysis.completed`, `analysis.failed`,
`test_run.created`, `test_run.completed`, `test_run.failed`,
`browser_matrix.created`, `browser_matrix.completed`,
`browser_matrix.failed`, `regression.detected`, `report.created`,
`member.joined`, `export.completed`, `export.failed`.

Payloads are metadata only — ids, statuses, scores. Source code, secrets,
internal URLs and infrastructure details are never included.

## Signature

Every delivery POSTs the JSON body with:

```
X-ExtensionLab-Signature: t=<unix ts>,e=<event id>,v1=<hex hmac-sha256>
```

The MAC is `HMAC-SHA256(secret, "<timestamp>.<eventId>.<body>")`. Verify by:

1. parsing `t`, `e`, `v1` from the header;
2. recomputing the MAC over `t + "." + e + "." + rawBody`;
3. comparing in constant time;
4. rejecting timestamps outside your replay tolerance (e.g. 5 minutes).

Every event carries a unique id (`evt_…`) — use it (with the timestamp) for
replay protection and de-duplication.

## Delivery semantics

- Deliveries run as durable `WEBHOOK_DELIVERY` jobs; delivery rows are the
  audit trail (status, attempts, HTTP status, next attempt, terminal state).
- **Timeout** per attempt: `WEBHOOK_TIMEOUT` (default 10 s). Redirects are
  not followed. The response body is never read (size/parse safety).
- **Success** is any 2xx.
- **Retries**: exponential backoff — `WEBHOOK_BACKOFF_BASE_MS * 2^(n-1)`
  capped at 1 hour, up to `WEBHOOK_MAX_RETRIES` (default 5) retries; beyond
  that the delivery becomes `dead_letter` and stays inspectable.
- Crashed workers are recovered by the scheduled sweep, which re-schedules
  due-but-pending deliveries; a worker crash never silently drops an event.
- History per webhook is bounded (`WEBHOOK_HISTORY_PER_WEBHOOK`, default 100).

## Failure isolation

Event dispatch is wrapped so a webhook subsystem failure can never break the
business flow that emitted the event. Slow or broken endpoints affect only
their own deliveries.

## Testing

`tests/phase10/webhooks.test.ts` covers signing determinism and tamper
detection, SSRF/private-range rejection, dispatch fan-out, 2xx success
without reading the body, retry→dead-letter progression with backoff, crash
recovery sweeps and secret-free listings.
