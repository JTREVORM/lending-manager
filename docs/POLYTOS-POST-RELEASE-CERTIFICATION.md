# POLYTOS post-release operational certification

Certification date: 30 October 2026 (Africa/Kampala).

**Decision: PARTIALLY VERIFIED. Production operational certification is blocked
by unexecuted mandatory hosted authentication and session tests.**

PR #16 is merged and its exact merge revision is deployed to Production. Public
health and direct Supabase readiness now pass. Read-only production finances
match the certified baseline. No approved existing hosted test-account source
was available during this verification; hosted login/session/role tests are
BLOCKED, not PASS.

## Release identity and rollback

- Repository: `JTREVORM/lending-manager`.
- Production branch: `claude/intelligent-knuth-2r8mpw`.
- Approved source: `fc8f532b2c13dff68dfca045fcff95551b31141d`.
- [Merged PR #16](https://github.com/JTREVORM/lending-manager/pull/16).
- Merge commit: `b7f2aa700e1f9ecc54a9f5f833e440aae293a5be`.
- Production deployment: `dpl_9W4nfLXRQw3canjyjeVmL6AgiYeX`, **READY**.
- Production alias: https://lending-manager-ten.vercel.app.
- Build URL:
  https://lending-manager-atcgfba9f-mwesigwatrevorjoseph-9675s-projects.vercel.app.
- Existing Vercel project: `prj_1qpwIN5eEEDrsmcJzWJ9Cq5owwal`.
- Team: `team_eFoHugEYsyJpUwYM5SwAmrHp`.
- Rollback deployment: `dpl_HhheZDv77TctX4zq1xVg8sjrNQJb`, previously READY,
  commit `84eafacd9d943bb62ae95ae86706f08738d1dde7`.
- Rollback URL:
  https://lending-manager-f1a2ayn0x-mwesigwatrevorjoseph-9675s-projects.vercel.app.

Before merge, the PR head matched the approval, its base matched the existing
production revision, GitHub reported it mergeable, and there were no unresolved
review threads. The draft was marked ready and merged with an expected-head
check. No check was bypassed or force merge used.

GitHub comparison confirms the approved source is an ancestor of the merge and
the merge introduces no file changes relative to that source. The production
branch was verified identical to the merge revision.

Vercel Git integration automatically started a fresh Production build on merge,
while post-merge CI was still running. No manual deployment or duplicate build
was requested. Deployment metadata identifies the exact merge SHA, and the
production alias resolves to this deployment. Existing environment variables
were preserved. The prior artifact was not promoted or reused.

The rollback reference is recorded only; no rollback was executed. The previous
deployment retains the superseded readiness probe and is not a healthy readiness
fallback.

## CI evidence

[Approved-source CI run 41054218208](https://github.com/JTREVORM/lending-manager/actions/runs/41054218208)
completed successfully on the exact approved head, with all three jobs passing.

[Post-merge CI run 41078323903](https://github.com/JTREVORM/lending-manager/actions/runs/41078323903)
is a push-triggered run whose reported head is exactly
`b7f2aa700e1f9ecc54a9f5f833e440aae293a5be`.

- **PASS:** checks, unit/integration, build (job `124140401706`).
- **PASS:** database (real PostgreSQL) (job `124140401857`).
- **PASS:** browser E2E (production build, fresh seed) (job `124140401164`).

All three required jobs completed successfully on the merge revision.

These suites use disposable PostgreSQL and real PostgREST. The browser suite's
Auth service is a local shim. Passing isolated tests does not certify hosted
Supabase Auth or real production sessions.

## Migration and readiness

Supabase access used **LENDING MANAGER**, project `fszgwemtgyrbhngajpzm`.
The Primary connection was not used.

Migration history records version `20261030115530`, name `polytos_readiness`,
matching `supabase/migrations/20261030115530_polytos_readiness.sql`. The
migration had already been applied by the operator. It was not reapplied,
renamed, or modified during this release; no additional migration was applied.

Catalog inspection confirms an argument-free STABLE SQL function returning
only `true`, SECURITY INVOKER, with an empty search path. Execution is allowed
for anon and authenticated and denied for service_role.

At **18:16:18 EAT**, an external GET to
`/rest/v1/rpc/polytos_readiness` on the production Supabase project supplied an
enabled modern publishable key in the `apikey` header. Actual result:

- HTTP status: **200**.
- Exact response body: `true`.
- Parsed type/value: JSON boolean `true`.
- Result: **PASS**.

Only the publishable key was retrieved for this check. No credential value was
printed or committed; no secret/service-role key was retrieved.

## Production health and failure behavior

At **18:12:52 EAT**, an anonymous GET to the production alias's
`/api/health` returned **HTTP 200** with exactly:

```json
{
  "status": "ok",
  "dataApi": "ok",
  "version": "0.1.0",
  "environment": "production"
}
```

The response had `Cache-Control: no-store, no-cache, must-revalidate`,
`Age: 0`, `x-vercel-cache: MISS`, and JSON content type. No unexpected
response fields, credentials, database location, counts, or upstream errors
were exposed. Source inspection confirms force-dynamic rendering, zero
revalidation, an uncached upstream GET, redirect refusal, and a four-second
dependency timeout.

An additional isolated execution of the unchanged health handler used real
unmocked fetch against a closed loopback port. It returned **HTTP 503**,
`status: degraded`, `dataApi: unreachable`, the same no-store header, and
one sanitized warning. Environment/logger adapters and native
`Response.json` supplied the surrounding handler dependencies. This is
isolated handler evidence, not a full Next.js deployment outage test.
Production dependencies were never disrupted.

The exact approved-source CI also executed the route regression suite covering
gateway failures, invalid JSON, incorrect values, redirects, timeout,
configuration errors, and sanitized output/logging.

Runtime error/fatal count queries for the new deployment, from its READY time
through the inspection, returned no matching groups. This bounded log result
does not establish that every runtime path was exercised.

A follow-up production GET at **18:47:15 EAT** returned the same HTTP 200,
four-field healthy response and no-store header. The direct Supabase RPC
again returned HTTP 200 with JSON boolean true at **18:47:13 EAT**. The
production alias still resolved to the same READY merge deployment; no
additional deployment was requested.

## Hosted authentication and authorization

Executed against the new production alias:

- Login page: **HTTP 200**, CSP, nosniff, private/no-store response headers.
- Anonymous access to `/membership/policy-transitions`, `/loans`,
  `/savings`, `/benefits`, and `/finance/ledger`: **HTTP 307** to
  the login page, with private/no-store response headers.
- No session cookie was created by these anonymous GET requests.

### Hosted account availability review

A read-only follow-up on 30 October 2026 inspected LENDING MANAGER only.
At **18:46:52 EAT**, the hosted catalog contained four non-deleted Auth users:
all four had confirmed email identities, a configured password, and a linked
profile. Two had a previous sign-in timestamp. These are inventory facts,
not newly executed sign-in or session evidence. No account identifiers,
password hashes, recovery tokens, or session tokens were exported.

There are six active application profiles, four linked to hosted Auth users.
The linked roles are owner_admin (one), manager (one), and
secretary_treasurer (two). No linked client-role account or non-NULL branch
assignment was observed in this inventory. Two linked profiles require a
password change. These observations do not identify an approved test account
or supply its password; first-login password changes were not attempted.

The public hosted Auth settings endpoint returned **HTTP 200** at
**18:47:12 EAT** using an enabled publishable key. It reports email enabled;
anonymous users, phone, and the listed OAuth providers disabled; signup
enabled; and email autoconfirm disabled, so email confirmation is required.
The configured SMS-provider label does not establish a working phone flow:
phone authentication is disabled. Server-only Auth settings, including
session timeout/renewal configuration, were not available through this public
response and are not certified by it. No Auth setting was changed.

Repository inspection covered `README.md`, `docs/AUTHENTICATION.md`,
`docs/PRODUCTION.md`, `docs/DELIVERY.md`, `docs/SECURITY.md`,
`docs/INCIDENT-RUNBOOK.md`, `docs/LAUNCH-CHECKLIST.md`,
`docs/FULL-SYSTEM-DEMO-VALIDATION-REPORT.md`, the POLYTOS demo integration
documentation, `scripts/bootstrap-owner.ts`, `scripts/seed-demo.ts`, and
the E2E fixture, setup, and Auth-shim files at the deployed source revision.

The account documentation describes first-Owner provisioning and a temporary
password supplied or generated for one-time handoff to the operator. It does
not identify an approved hosted test-account list or a verified secure
credential location. The local E2E fixtures belong to the disposable
PostgreSQL/Auth-shim stack; their passwords were not tried against hosted
Auth. The hosted demo seeder intentionally leaves newly created demo staff
profiles without an Auth login; its direct Auth-row creation is restricted
to local targets. Demo profile existence therefore supplies no hosted login
credential or approval.

The project owner confirmed that no verified secure source for approved
hosted test-account credentials has been provided. None was identified in
the reviewed sources. **Hosted authentication and session tests remain
BLOCKED.** The mandatory test list below remains outstanding in full.
No account creation, reset, password change, signup, token issuance, or
provisioning/seeding script was performed during this inspection.

The following mandatory tests are **BLOCKED** because access to approved
existing hosted test accounts was unavailable:

- Successful hosted Supabase Auth login and verified identity/profile.
- Persistence across authenticated navigation and browser refresh.
- Authenticated session-cookie attributes and handling.
- Token renewal, expiry, logout, and session invalidation.
- Authenticated role-based and branch-based access.
- RLS behavior using actual hosted user sessions.

No accounts were created, modified, reset, or deleted. No guessed credentials
or isolated-harness accounts were used against production. Anonymous route
checks and database catalog checks do not substitute for these tests.

## Database permissions and security

The follow-up recheck again found the same 80 public tables with RLS,
zero anonymously executable public SECURITY DEFINER functions, and zero
public definers missing the empty search path.

Read-only catalog inspection found:

- All **80** public tables have RLS enabled.
- **0** public SECURITY DEFINER functions executable by anon.
- **0** public SECURITY DEFINER functions without the empty search path.
- Anon SELECT denied on loans, loan payments, memberships, savings accounts,
  savings transactions, journal entries, and journal lines.

The advisor's two ERROR-class view findings were inspected rather than ignored:
`company_identity` is the documented authenticated-only projection of
published company/contact fields; anon SELECT is denied and tax/registration
identifiers are excluded. `__gate_probe` is an existing anonymous view whose
entire definition is `SELECT 1 AS one`. It exposes no financial/member rows
but remains recorded schema drift.

The **117** authenticated SECURITY DEFINER warnings match the documented
transactional RPC architecture. Their existence alone is not a demonstrated
vulnerability. Hosted authenticated negative-role testing remains blocked.

Outstanding hardening/governance findings remain:

- [Leaked-password protection is disabled](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- Previously recorded shared Preview/Production environment scope requires
  review before any hosted preview write tests.
- Historical migration timestamp variants and the extra probe view remain.
- Previously recorded branch-protection governance requires review.

No database grant, RLS policy, credential, environment variable, or repository
protection setting was changed to silence these findings. The readiness fix,
public-key validator, test-target isolation, and dependency audit changes are
the reviewed source in PR #16. No new critical exploit was established by
these checks; this is not a substitute for blocked hosted user tests.

## Read-only financial reconciliation

A follow-up **REPEATABLE READ, READ ONLY** snapshot at **18:49:47 EAT**
again matched all 31 certified table counts and fingerprints. It reconfirmed
35 loans, 470 payments, savings/GL 2100 of UGX 1,010,000, principal/GL 1200
of UGX 8,738,693, and journal debits/credits of UGX 89,649,530. Unbalanced
journals, posted-allocation mismatches, negative loan components, and
negative savings balances were all zero. Policy 2.0 remained draft,
unapproved, undated, unassigned, and disabled. No demo record was altered.

The main production comparison used one **REPEATABLE READ, READ ONLY**
transaction at **18:13:23 EAT**. All amounts are integer UGX.

- Loans: **35**; loan payments: **470**.
- Savings subledger = GL 2100: **1,010,000**.
- Remaining loan principal = GL 1200: **8,738,693**.
- Journal debit total = credit total: **89,649,530**.
- Trial-balance totals agree; all **35** ledger account balances independently
  matched the earlier certified per-account baseline.
- Journals: **597**; lines: **1,667**; unbalanced journals: **0**.
- Journals without lines, orphan lines, and savings transactions without
  journals: **0** each.
- Posted receipt/allocation mismatches and allocation component mismatches:
  **0** each.
- Negative loan components, savings balances, and ledger balances: **0**.
- Posted receipts: **469**, totaling **22,286,867**.
- Reversed receipts: **1**, retaining historical amount **130,000**.
- A separate consistent read-only reversal check found one reversed journal
  pair, no reversed receipt missing its contra entry, and no account-level
  debit/credit reversal mismatch.

All **31** table counts and sorted-JSON MD5 consistency fingerprints matched
the certified evidence at
`docs/evidence/polytos-operational-certification-2026-10-30.json`.
This includes financial records, original terms, policies, reference sequences,
and all **1,668** audit rows. No differences needed classification as
legitimate changes or discrepancies. MD5 is a consistency check, not a backup.

Financial result: **PASS for the executed read-only reconciliation**.
No financial posting or corrective data write was performed. No live benefit,
fine, withdrawal, or payment workflow is claimed as tested by these aggregates.

## Policy 2.0 protection

The same main snapshot confirms version **2.0** remains:

- **Draft**, unapproved, and without an effective date.
- With **0** policy assignments, memberships, or savings accounts.
- Financially disabled, with enrolment, savings, member lending, benefits,
  and profit sharing disabled.
- Medical ceiling mode and profit distribution basis still NULL.

Policy result: **PASS**. No policy activation, fines, benefit processing,
member transition, or existing loan-schedule change was performed. Medical
benefit ceiling and profit distribution remain management decisions.

## Certification decision and remaining work

**PARTIALLY VERIFIED; NOT OPERATIONALLY CERTIFIED.**

Merge, exact deployment identity, public health/readiness, anonymous route
protection, catalog security checks, read-only finance reconciliation, and
Policy 2.0 preservation have execution evidence. Post-merge CI is recorded
above. Mandatory real hosted authentication/session/role tests remain blocked.

Complete those tests using approved existing accounts through a secure access
path, record the actual outcomes, and reassess final certification. Do not
mark them PASS from local Auth-shim results.

This report is submitted in a separate documentation PR. That PR is not merged
and does not authorize another production deployment. Its source branch has
Vercel Git deployments disabled by the existing source configuration.

The earlier pre-release report and connectivity diagnosis are historical
evidence, not the current live-health decision. They remain available at the
[approved source revision](https://github.com/JTREVORM/lending-manager/blob/fc8f532b2c13dff68dfca045fcff95551b31141d/docs/POLYTOS-POST-RELEASE-CERTIFICATION.md)
and in `docs/POLYTOS-CONNECTIVITY-REMEDIATION.md`.
