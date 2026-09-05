# API keys

Organization API keys authenticate `/api/v1/*` requests (see `docs/API.md`).

## Format & storage

- `el_<6 hex prefix>_<secret>` — cryptographically random (256-bit secret).
- Stored **only** as a SHA-256 hash; the prefix is stored in the clear so keys
  can be identified in lists after creation.
- The full key is returned exactly once, in the creation response. It cannot
  be recovered later — by anyone.

## Lifecycle

- **Creation** — owners/admins only, gated by the organization's `apiAccess`
  entitlement (Pro+). Name (1–80 chars), scopes and expiry (default
  `API_KEY_TTL_MS`, max 730 days) are set at creation.
- **Use** — every request re-validates the hash, expiry and revocation state.
  `last_used_at` is updated (throttled) for the security UI.
- **Revocation** — immediate and audited; the key stops working on the next
  request.

## Scopes

Twelve scopes across seven resources (`packages`, `analysis`, `tests`,
`reports`, `browser-matrix`, `webhooks`, `organization`), each `read` or
`write`. Defaults for new keys are the least-privilege read set
(`packages:read analysis:read tests:read`). The service rejects:

- empty scope lists (least privilege means *choosing*, not bypassing),
- unknown scopes,
- more scopes than the deployment maximum (`PUBLIC_API_MAX_SCOPES`, 12).

There is deliberately **no** `*`/unrestricted scope.

## Authorization model

A key acts with the organization role of the human who created it:

- a key created by a `viewer` cannot trigger writes even with a write scope —
  the route checks `roleHasPermission(creatorRole, action)` after the scope
  check;
- a key created by an `admin` inherits admin capabilities but never owner-only
  actions (billing, SSO, org deletion);
- keys are bound to one organization at creation; the organization id can
  never be supplied or changed via request parameters.

## Limits & abuse protections

- Per-organization key cap (`ORG_MAX_API_KEYS_PER_ORG`, default 20).
- All v1 traffic is rate-limited per key, per organization and per IP
  (independent of quotas) — see `docs/API.md`.
- Authentication failures are audited and counted; repeated failures from one
  source trip the IP bucket.
- Key use is audited (`api_key.*` actions) with the key id as actor.

## Testing

`tests/phase10/api-keys.test.ts` covers hashing at rest, prefix identity,
least-privilege defaults, scope validation, expiry enforcement (fail-closed
authentication), creator-role authorization, revocation, the entitlement gate
and secret-free listings. `tests/phase10/public-api.test.ts` exercises the
routes end-to-end (auth, scopes, tenant isolation, rate limits, idempotency,
error envelope).
