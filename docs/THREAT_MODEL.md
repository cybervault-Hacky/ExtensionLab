# Threat Model — ExtensionLab Phase 20

## Trust Boundaries

- User / Client Browser
- Web Application (Next.js)
- API Layer (existing v1 support + middleware)
- Database (SQLite / PostgreSQL)
- Queue / Workers (existing Phase 6/13)
- Browser Sandbox (Phase 3/11/13)
- Object Storage
- External: Razorpay / GitHub / AI / Email / Webhooks

Every boundary must enforce authorization; no boundary trusts the previous tier implicitly.

## Attackers

### Anonymous
- Abuse signup/login rate limits
- Upload malicious ZIP
- Attempt SSRF through browser/webhook
- Abuse public APIs (discover/search)
- Attempt injection in user content (posts/comments/mentions)

Mitigations: rate limits; input validation; ZIP verification; SSRF protections; public API bounded; content sanitized.

### Authenticated User
- IDOR across users/organizations
- Cross-org access via organization ID manipulation
- Abuse API keys (scope enforcement)
- Abuse notifications (self-block, blocked-user suppression, dedupe)
- Abuse community (spam, mentions, block bypass)
- Abuse package upload (duplicate, substitution attempts)

Mitigations: server-side authorization; organization isolation; API scopes; block enforcement; visibility checks; exact SHA-256 package binding.

### Organization Member / Malicious Developer
- Privilege escalation (role bypass)
- Access organization test/CI/reports without authorization
- Abuse organization API keys
- Access private organization extensions/reports

Mitigations: existing organization authorization; role checks; package/test/run ownership tied to organization; no cross-org data leakage.

### Malicious Uploaded Extension
- Manifest lies
- JavaScript execution inside sandbox
- Network access attempts
- File system attempts
- Dangerous URLs/assets

Mitigations: isolated container (non-root, cap-drop, read-only); untrusted extension treated as hostile; no host filesystem/network access; allowlisted browser commands only; navigation validated; artifacts bounded.

## Key Risks Addressed

- Authentication: existing password hash + session security preserved
- Authorization: every endpoint uses existing auth middleware; no anonymous private access
- Data integrity: exact package SHA-256; database transactions; idempotency
- Availability: circuit breakers where existing; graceful failure; no fake success
- Secrets: none in repo; scan clean
- Upload: max size; MIME; SHA verification; no execution
- Browser: sandbox restrictions; command allowlist; session isolation
- Community: visibility enforced; blocked users suppressed; no arbitrary HTML
- Analytics: server-side authorization; no private data in public; no synthetic metrics

## Unverified (Requires Operator Configuration)

- Production CSP/proxy headers (deployment-level)
- Redis/S3/DB production tuning
- Backup execution verification
- Load test results
- Failure injection results
- External provider E2E (Razorpay, GitHub, AI)
