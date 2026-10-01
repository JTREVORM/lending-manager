# Security

## Posture

The database is the security boundary. Application checks — `lib/permissions/`,
a disabled button, a guard in a Server Action — are a usability layer, and a
caller holding a valid token can bypass all of them by talking to the Supabase
REST API directly. Row Level Security is what actually decides who sees what,
so every rule expressed in TypeScript must also exist as a policy.

Phase 1 is **default-deny**: RLS enabled on all nine tables, policies on two
non-sensitive lookup tables only, and zero privileges for `anon` anywhere.

## Review performed before declaring Phase 1 complete

| Check | Result |
| --- | --- |
| Secrets in the repository | None. Only `.env.example`, which holds variable names. |
| Secret key in the client bundle | Scanned `.next/static/` for `sb_secret_`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`. Clean. |
| Secret key in rendered HTML | Clean. |
| `NEXT_PUBLIC_` prefix on a secret | Rejected by `lib/env.public.ts`, and `npm run check:env` scans every public variable for an `sb_secret_` value. |
| Public storage buckets | All three private. |
| Overly broad policies | One `USING (true)`, on `roles` — four role keys and their labels. Asserted by test. |
| RLS enabled everywhere | Asserted against the catalogue. |
| SQL injection | No string-interpolated SQL. Supabase query builder in the app; parameterised queries in tests. |
| Input validation | Zod at the boundary, `CHECK`/`UNIQUE`/`NOT NULL` in the database. Neither relied on alone. |
| Sensitive data in logs | Redaction by key name and value shape, unit-tested. `console` forbidden by ESLint. |
| Hard-coded credentials | None. |
| `search_path` on functions | All eight pin `search_path = ''`. Asserted against the catalogue. |
| `EXECUTE` on privileged functions | Revoked from `PUBLIC`, `anon` and `authenticated`. Asserted per function. |
| Authentication bypasses | No authentication exists yet; nothing claims to protect a route. |
| Security headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, no `X-Powered-By`. Verified against a running server. |

## Issue found and fixed during review

**Privileged functions were callable by anonymous visitors.**

The migrations revoked `EXECUTE` from `PUBLIC`, which is the usual advice and
is what PostgreSQL's default grant requires. It was not enough. Supabase
*additionally* grants `EXECUTE` to `anon`, `authenticated` and `service_role`
through `ALTER DEFAULT PRIVILEGES`, and an explicit grant is not removed by a
revoke from `PUBLIC`.

The consequence: `next_reference()` and `record_audit_event()` were executable
by `anon`, and the four session helpers were executable by `anon` as well as
`authenticated`. An anonymous caller could have inflated the reference counters
or written rows into the audit trail.

Found by `tests/db/security.test.ts`, which asserts the grant per role rather
than trusting that the revoke worked. Fixed by naming each role explicitly in
the `REVOKE`, then granting back to `authenticated` only where intended. The
test now covers every privileged function, so a future function cannot
reintroduce it.

This is recorded because it is the kind of mistake that reads as correct: the
SQL said `revoke all … from public`, the comment above it said "revoked from
everyone", and only a query against the catalogue showed otherwise.

## Function hardening

Every function sets `search_path = ''` and schema-qualifies everything it
touches, including built-ins (`pg_catalog.now()`). Without that, a caller can
prepend a schema they control to their `search_path` and have a
`SECURITY DEFINER` function resolve `profiles` to their own table.

Note that `COALESCE` and `NULLIF` are SQL constructs, not functions, and cannot
be schema-qualified — an earlier draft tried, and the function failed at
runtime.

The four session helpers are `SECURITY DEFINER` only to escape RLS recursion
(a policy on `user_roles` that queried `user_roles` would not terminate). Each
is scoped to the calling user through `auth.uid()`, so none can read another
person's data.

`current_profile_id()` resolves only **active** profiles. A suspended or
archived account therefore has no identity for authorization purposes even
while its auth session is still technically valid.

## Audit trail integrity

Three independent controls: statement-level triggers rejecting `UPDATE`,
`DELETE` and `TRUNCATE`; those privileges revoked from every role including
`service_role`; and RLS with no policies.

A database superuser can still disable a trigger. No in-database design
prevents that, and claiming otherwise would be dishonest. What this does
prevent is every route available to the application, to a compromised
publishable or secret key, and to a mistaken `DELETE FROM`.

Stronger tamper-evidence — shipping records off-site, or hash-chaining each row
to its predecessor — is a Phase 2+ consideration, and worth taking if the
business needs the trail to stand up to an insider with database access.

## Session handling

`proxy.ts` refreshes the Supabase session on every matched request and applies
the `Cache-Control`, `Expires` and `Pragma` headers that `@supabase/ssr`
supplies alongside refreshed cookies. Without those, a CDN or ISR layer can
cache a response carrying a `Set-Cookie` and serve it to a different visitor,
who would then be signed in as somebody else.

`app/(app)/layout.tsx` is `force-dynamic`, so nothing in the authenticated area
is prerendered or shared-cached.

Session validity is established with `supabase.auth.getClaims()`, which
verifies the JWT signature on every call. `getSession()` does not, and a cookie
is attacker-controlled input, so it is never trusted server-side.

## Personal data

`audit_log` records `ip_address` and `user_agent`, which are personal data.
They are retained for security investigation. **The business should set a
retention period before going live**; Phase 1 sets none, and this is a known
gap rather than an oversight.

Client and guarantor documents — National Identification photographs in
particular — live in private buckets reachable only through short-lived signed
URLs. Phase 2 must define who may mint those URLs before any upload workflow
ships.

Logs mask phone numbers and emails and describe money by order of magnitude
rather than by value.

## Phase 2 verification

| Check | Result |
| --- | --- |
| Anonymous access to any table | Denied at the grant level — `anon` holds no privilege anywhere. |
| Client reading staff records | Returns zero rows. Driven as the `authenticated` role against a real database. |
| Staff promoting themselves | Refused by trigger. Including an Owner — nobody edits their own role assignments. |
| Manager becoming Owner | Refused twice over: the capability check, and independently the rank rule. |
| Deleting audit history | Refused for every role, by trigger and by revoked privilege. |
| Removing the last Owner | Refused, including under two genuinely concurrent committing transactions. |
| Disabling a user actually stopping access | Verified with the same token before and after, for all three inactive statuses. |
| Secrets in the client bundle | Clean: `sb_secret_`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `service_role` all absent from `.next/static/`. |
| Direct API calls bypassing the interface | Every escalation test runs as the `authenticated` database role, not through the application. |
| Forging a role assignment | `granted_by` is overwritten with the acting profile. |
| Account enumeration | One message for every sign-in failure, including a malformed number. |
| Open redirect on sign-in | `next` accepts only a plain in-site path; absolute, protocol-relative, `javascript:` and backslash forms are discarded. Verified against the running application. |
| Route protection | Every protected route returns 307 to sign-in for an anonymous request. No protected page returns 200, so there is no content flash. |
| Function `search_path` | All 21 `SECURITY DEFINER` functions pin `search_path = ''`. |
| Functions executable by `anon` | None. |
| Security headers after the auth changes | Unchanged, plus `Cache-Control: private, no-store` on authenticated responses. |

## Issues found and fixed in Phase 2

**Trigger functions were executable by `anon`.** `set_updated_at` and
`reject_mutation` kept PostgreSQL's default grant to `PUBLIC`. Not exploitable
— PostgreSQL refuses to call a function returning `trigger` outside a trigger
context — but revoked anyway in migration `20261002000700`, so that the answer
to "which functions can an anonymous visitor execute?" is an unqualified
"none". An audit that has to reason about why two entries are harmless will
eventually wave through a third that is not.

**`record_sign_in()` was blocked by its own guard.** The column guard refuses
any change to `last_sign_in_at` from a session, and `SECURITY DEFINER` does not
clear `auth.uid()`, so the sanctioned writer would have been refused. Found
while writing the migration; the guard now honours the transaction-local marker
the function sets.

**The `next` parameter was captured and never honoured.** The proxy recorded
where a visitor was heading, and sign-in ignored it. Found during the running
application review. Now honoured, sanitised twice — once when rendering the
form and again in the action, because a hidden field is client-supplied input.

## Known gaps, deferred deliberately

| Gap | Phase |
| --- | --- |
| No Content-Security-Policy | 2. A nonce-based CSP must be wired through the proxy; adding one now would break the auth flows that do not exist yet. |
| ~~No route protection~~ | **Done in Phase 2.** Three layers: proxy, server-side route guard, Row Level Security. |
| ~~No RLS policies~~ | **Done in Phase 2** for every identity, settings and audit table. `reference_formats` and `reference_sequences` remain default-deny deliberately — nothing reads them from a session. |
| No rate limiting on user creation or password reset | Before go-live. Supabase Auth throttles sign-in itself; the administrative actions are not throttled. |
| A user can clear their own forced-password-change flag without changing the password | Only by calling `complete_password_change()` directly, which requires already being signed in with the temporary password. It grants no additional access and inconveniences only themselves. Closing it fully would mean routing password changes through the privileged client. |
| No audit-record retention policy | Before go-live. |
| No audit hash chain or off-site shipping | 2+, if the threat model includes an insider with database access. |
| No penetration test | Before go-live. |

## Reporting

Security issues in this system should go to the Owner/Administrator directly,
not through a public issue tracker.
