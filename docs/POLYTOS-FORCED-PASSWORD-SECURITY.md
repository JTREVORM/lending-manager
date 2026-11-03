# Phase 5: forced-password authorization boundary

Date: 30 October 2026 (UTC). Status: **HIGH severity; reproduced in isolation;
correction proposed, NOT applied to production. Phase 5 certification BLOCKED.**

## Scope and evidence

Source baseline: draft PR #17 at
`d803cd3cfa936aeb17637c8bafcbf5465556cf01`, containing the deployed application
from merge `b7f2aa700e1f9ecc54a9f5f833e440aae293a5be`.

All new executions used a disposable sandbox, loopback PostgreSQL and real
PostgREST 12.2.3. No production database, account, password, Auth session,
financial record, schedule, RLS policy or configuration was changed or used as
a write-test target. No hosted credential was requested or retrieved. The
local Auth shim is NOT hosted Supabase Auth evidence. Policy 2.0 was not
activated. Existing production financial reconciliation remains historical,
point-in-time evidence; it was not rerun or advanced by this investigation.

The earlier certification report contains independent **production
database-only** checks showing forced Manager and Secretary/Treasurer subjects
retained capabilities and financial SELECT access. Those checks did not
authenticate through GoTrue or exercise an external production request.
No production exploitation or financial write is claimed.

At 18:13:36 UTC, a synthetic forced-change subject's locally signed JWT was
verified by real isolated PostgREST. Direct GET `/loans?select=id` returned
**HTTP 200 and 17 loan identifiers** before the correction. Staff SQL checks
also retained business identity and capabilities. This is actual
isolated HTTP reproduction, not merely a static inference. It is not a claim
that a hosted production JWT was obtained or used.

After applying the new migration and configuring the hook in the isolated
harness, the same class of request returned **HTTP 403**, code `42501`:

```json
{
  "code": "42501",
  "details": null,
  "hint": null,
  "message": "Business access requires an active account with a completed password change."
}
```

The demonstrated impact is authenticated financial disclosure despite the
mandatory-change restriction. Existing business write capabilities also remain
available in the old primitives, making integrity impact plausible, but no
pre-fix financial write exploit was executed. This is not a claim of
cross-role escalation: the bypass retains the assigned role's authority while
evading a required precondition. HIGH reflects access using a password that
an administrator also knows, before the user has established their own secret.

## Intended policy and trace

An active account with `must_change_password = true` may authenticate, obtain
its own minimal recovery context, change its password through the verified
server flow, refresh its Auth session and log out. It must have **no business
capabilities or financial reads/writes**, regardless of navigation, direct
Data API calls, embedded relations or replayed Server Actions. Inactive,
suspended, unlinked and roleless accounts have no business authority.

Previously:

- `current_profile_id()` checked active status only.
- Role/rank/capability helpers and capability/self/parent RLS policies derived
  their identity from that helper, retaining forced users' normal privileges.
- `current_session_context()` composed those business helpers and returned
  the flag without restricting business authority.
- Page guards and report exports checked the flag. General Server Action
  permission guards did not; the static role matrix still granted authority.
- Some authenticated definer RPCs, including `savings_pledged_amount`, read
  financial tables without consulting the business identity helper. Tightening
  RLS alone would therefore leave a direct-RPC path open.

## Proposed correction

New, unapplied migration:
`supabase/migrations/20261030180224_forced_password_authorization_boundary.sql`.

1. `current_profile_id()` now requires active status AND a cleared flag.
   All existing role assignments, capability definitions and RLS policy bodies
   remain unchanged; their shared business identity becomes unavailable.
2. `current_session_context()` becomes an explicitly separate recovery
   bootstrap. It returns only the verified caller's own active profile and
   assigned roles, retaining the existing response signature and outcomes.
   Raw bootstrap roles are not business authorization.
3. Auth-only sign-in stamping and closed-vocabulary audit RPCs resolve the
   active self directly, so forced login/logout/password-change evidence still
   works. The service-role-only `confirm_password_change(uuid)`, its ACL and
   column guards are unchanged. Current-password verification and Auth password
   update still precede trusted confirmation.
4. `requireAuth`, and consequently both permission guards, deny forced users.
   Their rendered permission list is empty and `contextCan` denies all
   capabilities. Self-details editing also refuses them. Only explicit
   authentication/recovery callers retain bootstrap access.
5. New invoker function `enforce_password_change()` is a **PostgREST
   db-pre-request hook** covering table routes AND definer RPCs. It returns no
   data, pins an empty search path, trusts verified `auth.uid()` and database
   account state, and uses PostgREST's own request settings, not client headers.
   Anonymous requests retain existing grants/RLS and do not resolve a profile.

The hook's exact recovery allowlist is GET/POST
`/rpc/current_session_context` and `/rpc/polytos_readiness`; POST only
`/rpc/record_sign_in`, `/rpc/record_security_event` and
`/rpc/consume_rate_limit`; and GET only `/company_identity`, the existing
non-financial published-branding projection needed by the recovery shell.
No arbitrary profile/table route or business RPC is allowlisted. Supabase
`/auth/v1` is a separate service, so token refresh/recovery/logout is not
intercepted. Hosted recovery delivery and real token expiry remain unverified.

**The migration alone is NOT a complete release. The configured request hook is
mandatory**, because not every existing definer RPC consults RLS helpers.
The isolated PostgREST configuration enables it. No production configuration
statement, account update, migration application or schema-cache reload was
executed during this work.

## Executed regression evidence

- Application unit/integration suites: **2,647 PASS**, 83 files.
- Focused database/security regression: **106 PASS**, five files, including
  13 new boundary tests. Active Owner/Admin, Manager, Secretary/Treasurer and
  borrower retain their permitted loan access after trusted confirmation.
  Forced users lose identity, roles, capabilities and loan rows; their own
  recovery bootstrap remains available. Inactive/suspended cases cover all
  four roles. The request hook is invoker/void, rejects missing-path business
  calls and permits only the tested recovery paths.
- New API/browser suite on desktop: **12 PASS**, including six setup checks.
  Each active staff role first reads loans, then the same unexpired JWT is
  denied after the flag changes. Loans, payments, journal lines, savings,
  profile embeddings and the financial scalar definer RPC return 403.
  Direct flag clearing, service-only confirmation and financial RPC writes
  are denied. Inactive/suspended JWTs are denied, with no recovery profile.
- A real browser using a fresh synthetic account completes forced login,
  refresh, protected-route denial, password verification/change/confirmation,
  restored financial access, logout and protected-route denial after logout.
  This does NOT establish hosted GoTrue session revocation semantics.
- TypeScript typecheck, ESLint, diff whitespace and financial arithmetic scan
  executed successfully; the arithmetic scan found no hazards in 71 files.
- The four isolated demo-seed regression projects passed 82 tests in total.
  The isolated Supabase security advisor reported the existing
  `company_identity` definer-view warning (ERROR classification), not a new
  financial-data finding. This is the documented non-financial branding
  projection; no production warning was suppressed or configuration changed.
- The first security CI run caught strict typing errors in new test fixtures
  and JSON handling. These were corrected without weakening lint rules or
  changing authorization assertions; that failed run is not labelled PASS.
- The full application/database/browser workflows are required on the exact
  security-PR head. Consult its GitHub Checks and PR execution summary for
  completed full-suite outcomes; earlier production/PR #17 passes do not
  substitute for this revision.

Initial full local PostgreSQL 18 run: 1,800 passed and four failed. One failure
was the old expectation of a column-trigger exception: the corrected RLS now
affects zero rows instead. That assertion was updated to verify zero affected
rows AND the persisted flag; all 106 focused security tests then passed.
The other three are pre-existing delete-constraint assertions expecting
`23503`; PostgreSQL 18 returns `23001` for those RESTRICT cases. They were
not weakened or changed. The repository's PostgreSQL 16 CI job is the
supported-version full regression gate. No failing run is labelled PASS.

## Existing __gate_probe view

PR #17's read-only hosted inventory records `SELECT 1 AS one`, updatable mask
zero, no custom trigger/rewrite rule, and seven broad grants to each of anon
and authenticated. No financial/member rows are read by that definition.
There is no application/source reference outside documentation. This is
unnecessary schema/grant drift, not demonstrated financial disclosure.

Recommended disposition: **restrict first**, not an unconditional DROP.
After separately authorized fresh read-only dependency/ACL/definition review,
revoke client privileges from PUBLIC, anon and authenticated; retain only
explicitly justified operator access. A later removal may use DROP VIEW
RESTRICT after dependency review, never CASCADE. No revocation/drop is included
in this migration and none was executed. Removing this constant view alone
does not fix the forced-password vulnerability. It is not used by readiness.

## Required authorization before production release

This PR is draft, unmerged and undeployed. Its branch disables Vercel Git
deployments in its first published commit. Existing secrets and financial
logic are untouched. Approval to implement isolated code is NOT approval to
perform any of the following production operations.

An owner must explicitly approve a coordinated release containing:

1. Reviewed exact security source SHA, all three green required CI jobs, and
   the chosen relationship to documentation PR #17; no force merge/bypass.
2. Apply ONLY the new reviewed migration to **LENDING MANAGER
   (`fszgwemtgyrbhngajpzm`)**, never Primary. Do not reapply readiness.
3. Inspect the existing PostgREST pre-request configuration, then activate
   `public.enforce_password_change` using supported configuration. Preserve
   and chain any existing hook; do not silently overwrite one. Review the
   concrete configuration SQL/change and reload method before execution.
   Verify the hook actually runs through the hosted Data API.
4. Merge/deploy the reviewed application revision with a fresh production
   build under the existing project, verifying the exact SHA and alias.
   Coordinate database/hook-first ordering and preserve environment variables.
   Rolling back only application code must NOT remove the database boundary.
5. Non-destructive hosted verification with approved existing account holders:
   normal/forced role access, direct financial API denial, permitted recovery,
   logout, refresh/expiry and inactive/suspended negative cases where approved
   principals exist. Never clear flags manually to make tests pass.
6. Separate explicit approval for any `__gate_probe` restriction/removal,
   after fresh dependency and grant review. This is not bundled implicitly.

Authorization does NOT include creating/resetting/modifying existing hosted
accounts/passwords, changing financial records, schedules or calculations,
deleting demo data, or activating Policy 2.0. Any password-change test using an
existing hosted forced account requires its holder's separately approved
action; local synthetic success is not authorization to change that account.

## Remaining Phase 5 gates

- Review, exact-head green CI, explicit production migration/hook/release
  authorization, actual activation and hosted negative-API verification.
- P5-01 through P5-06: precise identity, logout/tabs/Back, cookie attributes,
  private-window/protected routes, natural renewal and expiry/invalidation.
  Owner login/dashboard/reload/navigation remain **USER-REPORTED MANUAL**.
- P5-07/P5-08: Manager and both Secretary/Treasurer normal/forced hosted
  sessions and legitimate role denials. No approved automated credentials.
- P5-09: hosted borrower and meaningful cross-branch isolation remain BLOCKED
  by missing approved linked/scoped subjects. Do not create accounts to fill it.
- P5-10: hosted signed-session RLS/private-document and inactive/suspended/
  roleless coverage; isolate any write-denial tests rather than posting money.
- Probe-view disposition and previously recorded security/governance items
  remain open until explicitly reviewed.

**Not operationally certified.** A local fix and green regression suites do not
close the pending hosted-session evidence or authorize production changes.

