# Organizations (multi-tenant workspaces)

Phase 10 adds organizations on top of the existing per-user model. This is an
evolution, not a rewrite: personal workspaces keep every Phase 5–9 behaviour,
and organization membership is purely additive.

## Model

- **Organization** — name, unique slug, plan (`free`/`pro`/`business`), seat
  count, settings JSON. Created by a user who becomes its `owner`.
- **Membership** — one role per user per organization. A user may belong to any
  number of organizations plus their personal workspace.
- **Invitation** — email + role + one-time token. Tokens are `orginv_…`
  random values stored **hashed** (SHA-256); the raw token exists only in the
  inviting admin's one-time response. Invitations expire (default 7 days),
  can be revoked, and can be resent (which rotates the token).
- **Org-ownable resources** — packages, analyses, test runs, browser matrices,
  reports, API keys, webhooks, audit events, policies, exports and
  publications all carry an optional `organization_id`. Rows without one
  belong to a personal workspace and behave exactly as before.

## Roles (server-side RBAC)

| Role | Capabilities |
| --- | --- |
| `viewer` | Read organization resources and members. Cannot run anything expensive, manage keys, or change settings. |
| `developer` | Viewer + create/run packages, analyses, tests, matrices, regressions, reports, quality gates. |
| `admin` | Developer + manage members/invitations, API keys, webhooks, audit access, exports, domains, settings, publications, delete projects. |
| `owner` | Admin + delete the organization, billing, SSO configuration, ownership transfer. |

Every protected operation calls the centralized authorizer
(`authorizeOrgAction`) on the server. The UI never performs authorization —
it only hides what the server would refuse anyway. Rules enforced centrally:

- Admins cannot manage other admins (only owners can).
- Owners cannot leave without transferring ownership first (atomic swap).
- Non-members receive `ORGANIZATION_NOT_FOUND` — indistinguishable from a
  wrong id, so organization existence is never disclosed.
- The organization id is **never** taken from request parameters alone: API-key
  principals are bound to their key's organization, and session callers are
  bound to their validated membership.

## Workspace switching

The dashboard has a workspace switcher (personal + organizations). Selection
is stored in an httpOnly cookie (`extensionlab_workspace`) and is re-validated
against real memberships on every server read; a stale or forged value falls
back to the personal workspace. `/dashboard/organization/*` pages are guarded
server-side (`requireOrgPage`) — a member without the required role is
redirected, and the data APIs enforce the same rules independently.

## Seats and billing

- Seat usage = active members + open invitations.
- Acceptance is blocked when either the plan's member maximum or the
  provisioned seat count is reached (`SEAT_LIMIT_REACHED`).
- Organization plans extend the Phase 7 provider abstraction — no provider is
  hardcoded. Entitlements come from the central entitlement service
  (`apiAccess`, `webhooks`, `advancedAuditLogs`, `sso`, `dataExport`,
  `highConcurrency`, `advancedBrowserMatrix`, `ciCd`, …) with
  `ORG_PLAN_<PLAN>_<KEY>` environment overrides for deployments without a
  full billing integration.
- **Documented limitation:** when the configured billing provider cannot
  change seats automatically, an operator applies seat changes; the API
  surfaces the provider's capabilities so the UI can say so honestly.

## Audit trail

Every security-relevant organization action appends an immutable
(append-only) audit event: actor (user and/or API key), action, resource,
request id, IP, success, and bounded redacted metadata. Sensitive material —
passwords, tokens, cookies, authorization headers, source code, raw bodies —
is stripped before storage (`sanitizeAuditMetadata`), and the recorder never
throws into business flows. The audit UI (role-gated to admins) supports
action/actor/resource filters, date ranges, bounded search, pagination and
export of the current view.

## Data export

Admins can request an asynchronous export of organization data. Exports are
queued as `ORG_EXPORT` jobs, produced as metadata-only JSON (package bytes are
excluded by design), stored with a SHA-256, downloadable for a limited window
(default 24 h), audited, and removed automatically after retention (default
7 days). One active export per organization at a time.

## Retention

Organization audit events are retained per the deployment floor
(`AUDIT_RETENTION_DAYS`) extended by the organization's plan retention; the
scheduled cleanup applies both, per organization, and never deletes across
organizations.

## Testing

`tests/phase10/organizations.test.ts` covers lifecycle, the role matrix for
every resource family, invitation lifecycle (one-time tokens, expiry, revoke,
resend rotation, seat limits, no enumeration), membership administration,
ownership transfer and entitlement gates. `tests/phase10/tenant-isolation.test.ts`
proves packages, runs, matrices and reports are invisible across organizations.
