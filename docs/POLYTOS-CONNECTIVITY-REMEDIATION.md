# POLYTOS production connectivity remediation

Investigation: 30 October 2026, 14:02-14:07 Africa/Kampala (11:02-11:07 UTC).
Scope: Supabase LENDING MANAGER `fszgwemtgyrbhngajpzm` only.
Status: **branch implementation complete; production release blocked**.
No production migration, credential change or deployment has been performed.

## Implemented remediation and verification record

The branch now contains `supabase/migrations/20261030115530_polytos_readiness.sql` (created with Supabase CLI
2.119.0), `public.polytos_readiness()`, its typed declaration and the
replacement `/api/health` probe. The function is STABLE SQL, explicitly
SECURITY INVOKER, with an empty search_path, no arguments and a body consisting
only of SELECT true. Default PUBLIC execution is revoked; only anon and
authenticated receive explicit execution grants in addition to the owner.

The route requires HTTP 200 and the exact JSON boolean true. It preserves the
four-second timeout, no-store request/response behavior, four-field response
and HTTP 503 on failure. Redirects are refused. Upstream exception text and
bodies are not logged.

**Executed targeted evidence:** the 28 health regression tests produced
16 failures against the original route and 28 passes against the replacement.
They cover publishable and legacy-anon key shapes, gateway status failures,
malformed/incorrect JSON, redirects, configuration errors, connection failure,
response-body failure, timeout and sanitized output/logging. Keys are synthetic.

The database suite additionally verifies both intended roles in read-only
transactions, the exact function body/security/grants, denial for an unrelated
role, continued denial of anonymous financial/membership reads, and unchanged
existing relation, policy and function security metadata when the migration is
applied. Playwright exercises the RPC through real PostgREST and the public
health endpoint on the disposable stack. The existing public health tests are
retained.

The final full application, PostgreSQL and Playwright outcomes, exact tested
commit, run links and artifact IDs are recorded in the
[PR #16 verification record](https://github.com/JTREVORM/lending-manager/pull/16).
That record distinguishes passing, skipped, failed and superseded runs.
This document's implemented status refers to branch source only, not a hosted
RPC, production health, hosted login or runtime sign-off.

## Finding and correction to the initial certification

The readiness probe makes an invalid assumption: anonymous API keys can read
the PostgREST root at `/rest/v1/`. On this hosted project, that route rejects
both the active publishable key and the enabled legacy anon key with
`UNAUTHORIZED_INVALID_API_KEY_TYPE`. A correct key therefore reproduces the
failure. Replacing the production publishable key alone cannot fix this probe.

The same active publishable key succeeds against Auth settings and reaches
PostgREST on a table route. That table request is refused by PostgreSQL
permissions, as intended. This distinguishes root-route key-type admission from
a globally invalid key, database outage or financial permission defect.

This supersedes the initial report's inference that the production variable
must be replaced. The deployed variable's actual value remains unreadable;
its equality to the active project key is **not verified**. A second
configuration problem is possible, but has not been demonstrated.

## Executed read-only control requests

Requests used Node fetch in a nonpersistent sandbox with no exposed ports.
Only the active public keys were used; no secret/service-role key was fetched,
used or logged. Response bodies were discarded except sanitized health fields
and the table request's error code. No user session was created.

| Request | Credential | Actual result |
| --- | --- | --- |
| HEAD /rest/v1/ | Active publishable | 401; UNAUTHORIZED_INVALID_API_KEY_TYPE |
| HEAD /rest/v1/ | Enabled legacy anon | 401; UNAUTHORIZED_INVALID_API_KEY_TYPE |
| GET /rest/v1/ | Active publishable | 401; UNAUTHORIZED_INVALID_API_KEY_TYPE |
| HEAD /rest/v1/ with legacy bearer JWT too | Enabled legacy anon | 401; UNAUTHORIZED_INVALID_API_KEY_TYPE |
| GET /auth/v1/settings | Active publishable | 200 |
| HEAD /rest/v1/company_identity?select=*&limit=0 | Active publishable | 401; no gateway error header |
| GET /rest/v1/company_identity?select=*&limit=0 | Active publishable | 401; PostgreSQL code 42501 |
| GET production /api/health | No credential | 503; degraded; dataApi unreachable; production; version 0.1.0 |

The table requests selected zero rows and did not grant anonymous access.
Their permission denial is diagnostic evidence only; it is **not** accepted
as a successful application readiness check.

Supabase edge logs in the explicit 11:02-11:07 UTC window corroborated the
results: root GET 401 once; root HEAD 401 four times; Auth settings GET 200
once; table HEAD and GET 401 once each. Only root requests had the
key-type error hint. The sandbox was stopped after diagnosis.

## Implementation trace

- `app/api/health/route.ts` is identical in release
  `84eafacd9d943bb62ae95ae86706f08738d1dde7` and PR code revision
  `45802059a792df524a716046c73e0387476556c4`.
  It sends HEAD to the REST root with only an apikey header, a four-second
  timeout and no-store. Only response.ok counts as success.
- `lib/supabase/server.ts` constructs a fresh SSR client per request using
  the public URL/key and the request's session cookies.
- `lib/supabase/proxy.ts` uses that same public configuration, verifies user
  claims and refreshes cookies/cache headers. It does not use the admin key.
- `lib/supabase/admin.ts` separately reads `SUPABASE_SECRET_KEY` for explicit
  privileged operations. Changing that variable cannot repair this health path.
- The released public validator rejects an exact sb_secret_ prefix but does
  not establish key authenticity. PR #16 adds publishable/legacy-anon type
  validation; it still cannot prove project ownership, revocation or endpoint
  admission. That security fix is independent of the root-route defect.

## Production configuration metadata

Vercel project: `prj_1qpwIN5eEEDrsmcJzWJ9Cq5owwal` (lending-manager).
Team: `team_eFoHugEYsyJpUwYM5SwAmrHp`.
Production alias: https://lending-manager-ten.vercel.app.
Deployment: `dpl_HhheZDv77TctX4zq1xVg8sjrNQJb`, READY, release commit
`84eafacd9d943bb62ae95ae86706f08738d1dde7`.

The URL and publishable-key variables exist, are sensitive/unreadable through
the connector, and share Production and Preview scope. Their metadata predates
the release. Listing and single-variable reads returned no value; no comparison
of the stored values was possible. The secret-key value was never requested.

## Remediation sequence, for separate authorization

1. **Review and authorize the implemented probe contract.** Keep the
   privileged key out of health. Review the exact migration and source
   described above together with their isolated test evidence.
   The migration is implemented in the branch but **not applied to production**.
   It requires separate production migration authorization.
   Do not depend on the untracked hosted __gate_probe view, add privileges
   to financial tables, accept arbitrary 401/403 responses as healthy, or
   add a secret-key fallback.
2. **Verify configuration in the authorized operator's secure interface.**
   `NEXT_PUBLIC_SUPABASE_URL` must equal
   `https://fszgwemtgyrbhngajpzm.supabase.co`.
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` must be an enabled publishable key
   from that project's API Keys settings (the tested enabled key is named
   default, ID `3893c4c6-4c31-45db-8f1e-840653de703a`).
   Verify equality privately; record only match/type/status. Never paste a
   key into chat, a report, a shell argument, a URL or CI output.
   If already correct, leave it unchanged. Replacement is conditional on
   proving a mismatch, malformed value or disabled/revoked key.
   Do not rotate signing keys, legacy keys or `SUPABASE_SECRET_KEY` for
   this incident.
3. **If replacement is required and authorized**, update exactly
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in this Vercel project's Production
   environment, paired with the exact project URL. Use the active publishable
   key, without quotes, whitespace or line breaks; never a secret/service-role
   key. Account for the existing shared Production/Preview record: arrange
   Production-specific scoping through the operator interface without
   silently changing Preview configuration. Preview production-data access
   remains a separate unresolved finding.
4. **Release only after explicit authorization of the reviewed source revision,
   readiness migration and deployment.** Keep PR #16 unmerged unless
   merging is separately authorized. A configuration-only redeploy of the
   current release will still contain the defective root probe; the probe
   repair must be included in the approved source revision.
5. **Database procedure after authorization:** confirm LENDING MANAGER and
   the existing migration inventory; apply only the reviewed readiness
   migration above using the approved migration process. Do not blindly
   push or repair historical migration variants. Verify SECURITY INVOKER,
   the empty search_path and exact grants, then wait for/verify the PostgREST
   schema cache and require HTTP 200 with boolean true from the RPC using the
   public key. Do not deploy the new probe before the RPC is available.

6. **Vercel procedure after authorization:** open the verified lending-manager
   project, save any approved Production-only variable correction, then
   create a fresh Production build of the exact approved Git revision.
   For an environment-only change to an already-correct source revision,
   open its deployment menu, choose Redeploy, select Production and disable
   reuse of the existing build cache. For a probe source change, deploy the
   newly approved source revision instead of redeploying the old release.
   Verify the new deployment's source SHA, environment and production alias.
   NEXT_PUBLIC variables are build-time inputs, so updating a variable or
   promoting an old artifact alone does not update its embedded values.
   No CLI command was executed and no deployment was requested here.
7. **Rollback preparation:** record the prior deployment ID and configuration
   change before release. Rolling back an artifact built with an old key is
   unsafe if that key was subsequently revoked. Do not revoke any working
   key during this investigation.

References: [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys),
[Vercel environment variables](https://vercel.com/docs/environment-variables),
[Next.js public variable build behavior](https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser).

## Mandatory post-correction runtime gates

All items below remain pending. Auth settings HTTP 200 is not a login test.

- Confirm production /api/health returns uncached HTTP 200 with status ok and
  dataApi ok on the approved deployment; independently confirm the no-data
  RPC succeeds with the public key. Check failures still produce 503.
- Use approved existing test accounts to sign in through real hosted Supabase
  Auth; verify actual user identity and profile activation. Do not create,
  reset, suspend or modify accounts without authorization.
- Verify secure/HttpOnly/SameSite cookies, session persistence across
  navigation, token refresh/expiry, sign-out invalidation, private/no-store
  responses and no cross-user session reuse. Do not publish tokens or cookies.
- Verify actual role/capability/branch restrictions and direct RLS behavior for
  the approved available roles, including anonymous denial. Record unavailable
  roles as blockers, not passes. Permission write tests stay isolated unless
  hosted writes receive explicit authorization.
- Repeat the existing read-only financial reconciliation in a consistent
  snapshot: trial balance, principal versus GL 1200, savings versus GL 2100,
  receipt allocations, reversals, orphan journals and negative balances.
  Compare pre/post snapshots and distinguish legitimate concurrent activity
  from unexpected changes. No financial workflow may post hosted records
  under this investigation's authorization.
- Recheck Policy 2.0 remains draft, inactive, unapproved, undated and without
  assignments. Keep medical/profit rules undecided and demo records intact.
- Record timestamps, approved deployment SHA, actual outcomes and blockers in
  the certification report. Operational certification remains blocked until
  every mandatory applicable runtime gate passes.

No production credential, schema, financial record or policy state was changed.
The PR remains draft and unmerged. Production is still the original release;
the implemented RPC and health replacement require the separate release steps
above. Policy 2.0 remains inactive. No business or financial rule is changed.
