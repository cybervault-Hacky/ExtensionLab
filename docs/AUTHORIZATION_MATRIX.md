# Authorization Matrix — Phase 20

Every private resource requires server-side authorization derived from the authenticated identity (user + API key + organization), not from client-provided IDs.

| Resource | Auth Required | Authorization Check | Scope / Role | Visibility |
|---|---|---|---|---|
| User profile (public) | None / API key | profile_visibility = public | — | Public |
| User profile (private) | Owner or organization member | user_id == owner; org membership verified | tests:read / member | Private |
| Organization settings | Organization owner/admin | organization authorization service | admin | Private |
| Extension (public) | None | public visibility if configured | — | Public |
| Extension (private) | Owner / org member / API with access | extension user_id / package org membership | tests:write / member | Private |
| Package upload | API key + org | packages:write + org authorization | packages:write | Private |
| Test run trigger | API key + tests:write | test saved to user's org / accessible test | tests:write | Private |
| CI run (poll) | API key + tests:read | same organization as test | tests:read | Private |
| Browser session | Session / API | session ownership; no cross-user | — | Private |
| Report | Owner / org / authorized | report ownership / organization | reports:read | Private |
| Report (public share) | Share token or auth | existing share mechanism | — | Public (token) |
| Notification list | Authenticated user only | recipient_user_id == user | tests:read | Private |
| Notification read | Authenticated user only | recipient_user_id == user | tests:write | Private |
| Analytics overview | Authenticated + org access | user organization access or public config | tests:read | Mixed |
| Analytics extension | Authenticated + extension access | extension owner or org member | tests:read | Mixed |
| Social post (public) | None / auth | visibility = public | — | Public |
| Social post (private) | Author or allowed | visibility = private + author | — | Private |
| Comment / Like / Save | Authenticated | post visibility + block check + rate limit | — | Mixed |
| Collection (public) | None / auth | visibility = public | — | Mixed |
| Collection (private) | Owner | owner_user_id == user | — | Private |
| Webhook | API key + webhook secret verification | webhook destination verification | — | Private |
| Admin API | Admin token + environment check | ADMIN_API_ENABLED + token match | — | Private |

No endpoint may accept a user_id, organization_id, resource_id, or visibility flag from the client and use it directly without server-side verification against the authenticated identity.
