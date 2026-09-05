# Single sign-on (SSO)

ExtensionLab is designed to support organization-level single sign-on via a
**provider abstraction** over OIDC and SAML. This page documents the
configuration surface, the routing model and — honestly — its boundaries.

## What is implemented

- **Per-organization SSO configuration** (`oidc` or `saml`), stored as an
  SSO config row with status `configured` or `enforced`. Owner-only.
- **Secret handling**: configuration values matching secret-ish keys
  (`secret`, `password`, `private`, `token`, `credential`) are write-only —
  they are persisted for the adapter but returned masked (`••••••••`) from
  every read path and never appear in audit logs.
- **Domain verification**: an admin adds a domain, receives a TXT record
  (`_extensionlab-verify.<domain>` → `extensionlab-verify-<random>`), and
  triggers a **real DNS resolution** to verify. Nothing auto-verifies; DNS
  propagation is the admin's retry. Verified domains back SSO login routing.
- **Login routing**: an enforced SSO config plus a verified domain is the
  unit the login flow consults (`findSsoConfigForEmailDomain`) to route a
  user to their organization's identity provider.
- **Audit**: `sso.configured` / `sso.disabled` / `domain.*` events.

## Entitlement & deployment gating

SSO requires the organization `sso` entitlement (Business) **and** the
deployment-level flag `SSO_ENABLED=true`. Either missing → the configuration
API fails closed with a clear error, not a silent no-op.

## Assertion validation boundaries (documented, not faked)

ExtensionLab does **not** implement cryptographic assertion validation
inline. The OIDC/SAML protocol exchange — discovery, authorization-code
flow, signature/audience/InResponseTo checks — belongs to a provider adapter
registered at deployment time, exactly like the billing provider abstraction
of Phase 7. Concretely:

- The configuration layer refuses to mark a config `enforced` unless the
  protocol essentials are present (OIDC: issuer + authorization endpoint +
  token endpoint + client id + secret; SAML: entry point + IdP certificate +
  audience). A partial configuration stays `configured`.
- No code path ever *simulates* a successful login: there is no "test SSO"
  that fabricates a session. Until a real adapter is wired, enforced configs
  route but cannot authenticate, and the login flow says so.
- Tokens, assertions and session material are treated like all auth
  credentials: never logged, never audited, never returned to the browser.

## Security notes

- SSO configuration is owner-only and audited.
- Removing a verified domain removes its login routing.
- Membership and role checks are unaffected by SSO: SSO changes *how* a user
  authenticates, never *what* they may do.
