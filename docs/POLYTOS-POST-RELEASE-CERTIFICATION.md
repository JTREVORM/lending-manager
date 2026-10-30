# POLYTOS post-release operational certification

Certification date: 30 October 2026 (Africa/Kampala).

**Decision: PARTIALLY VERIFIED. Production operational certification is blocked
by remaining session/role tests and an unresolved forced-change authorization
boundary review. Owner basic access has USER-REPORTED manual evidence.**

PR #16 is merged and its exact merge revision is deployed to Production. Public
health and direct Supabase readiness now pass. Read-only production finances
match the certified baseline. The owner has now reported successful live login,
dashboard loading, browser-refresh persistence, and normal navigation. These
are USER-REPORTED manual results. Remaining checks are explicitly PENDING or
BLOCKED below; no credential sharing is requested.

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

At the earlier inventory review no approved credential source was available.
The subsequent Owner/Admin manual report below supersedes the blanket statement
that basic Owner access was untested. The agent has not obtained credentials
or operated any hosted user session.

### Owner/Admin manual evidence supplied by the user

Reported on 30 October 2026 (Africa/Kampala). Exact execution times, browser
version, elapsed session duration, and specific business workflows were not
provided.

| Check                                                             | Result                                                  | Evidence provenance  |
| ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------- |
| Login with the existing Owner/Admin account                       | PASS, as reported                                       | USER-REPORTED MANUAL |
| Owner/Admin dashboard loads                                       | PASS, as reported                                       | USER-REPORTED MANUAL |
| Browser refresh does not log the user out                         | PASS, as reported; short-term persistence               | USER-REPORTED MANUAL |
| Navigation and the functionality personally checked work normally | PASS only for the unspecified checks actually performed | USER-REPORTED MANUAL |

These observations are accepted as user-reported manual evidence. They are not
independently automated hosted Auth tests and do not certify every business
workflow, token renewal after expiry, logout invalidation, secure-cookie
attributes, other roles, or cross-user/branch isolation.

### Remaining manual and blocked coverage

The practical steps, expected outcomes, safe evidence format, and ten test IDs
are in [the Phase 5 manual checklist](POLYTOS-PHASE-5-MANUAL-CHECKLIST.md).

| ID    | Remaining check                                                                                                       | Current status                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| P5-01 | Explicit own identity/profile match and named permitted detail routes                                                 | PENDING MANUAL; basic Owner login/dashboard/navigation already user-reported                      |
| P5-02 | Logout, same-browser tabs, Back/hard-refresh and fresh protected GET denial                                           | PENDING MANUAL                                                                                    |
| P5-03 | Fresh private-window protected-route and safe return-path checks                                                      | PENDING MANUAL; earlier independent anonymous GET results remain recorded                         |
| P5-04 | Production cookie attributes/chunks, clearing on logout and authenticated no-store responses                          | PENDING MANUAL                                                                                    |
| P5-05 | Renewal past the actual JWT lifetime, including concurrent-tab navigation                                             | PENDING MANUAL; lifetime/config evidence needed                                                   |
| P5-06 | Natural inactivity/time-box expiry where configured, and global-logout refresh invalidation after existing JWT expiry | PENDING MANUAL; configuration-dependent, never assumed from browser reload                        |
| P5-07 | Manager hosted login, permitted reads and Owner-only route/control denial                                             | BLOCKED normal flow: existing Manager requires password change                                    |
| P5-08 | Secretary/Treasurer hosted login/session and role/identity/notification restrictions                                  | PENDING with the existing normal profile; BLOCKED normal flow for the other forced-change profile |
| P5-09 | Borrower own-record/other-person denial and meaningful cross-branch denial                                            | BLOCKED: no Auth-linked client role, one branch and no branch-assigned linked staff               |
| P5-10 | Hosted-user/API RLS and private-document checks; negative account-state coverage; forced-change boundary review       | PARTIALLY CHECKED at database-only level; hosted session checks and security review remain open   |

The agent will not request passwords, access tokens, or session-cookie values.
Account holders can report manual outcomes without sharing credentials. No
independent automated hosted login was performed. No account creation, reset,
password change, role change, or branch assignment is authorized here.

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
the reviewed source in PR #16. The current review identifies the forced-change data-layer authorization gap
below. Severity and remediation disposition remain unresolved; complete
negative-state authorization coverage cannot be certified.

### Phase 5 independent read-only permission review

The deployed source revision remains
`b7f2aa700e1f9ecc54a9f5f833e440aae293a5be`. TypeScript AST parsing extracted
the literal security-test allowlists and role matrix without executing
repository code. The live catalog was compared with those reviewed contracts.

- All **80** public tables have RLS enabled; anon has no SELECT, INSERT,
  UPDATE, or DELETE privilege on any of these physical tables.
- All **236** role-capability pairs exactly match
  `lib/permissions/permissions.ts`; all **126** public table/command policy
  entries match `tests/db/security.test.ts`.
- Every public policy is scoped to authenticated. Predicate-shape checks
  reproduce the source suite's capability/self/parent-delegation requirements;
  no exception was found. Only the six documented vocabulary tables have an
  unconditional read predicate. This is catalog/static evidence, not exhaustive
  dynamic proof of every predicate's semantics.
- All **275** SECURITY DEFINER names and **150** authenticated-executable
  function names exactly match the source allowlists. Of **313** public
  functions, the only anon-executable function is `polytos_readiness`.
  Every function pins an empty search path, and no definer grants EXECUTE
  to PUBLIC.
- All **15** storage policies are authenticated-only and include bucket and
  capability/self predicates. All **six** buckets are private and exclude SVG.
  No object download, upload, removal, or sharing-link creation was performed.
- All **48** expected source views are present. The existing hosted
  `__gate_probe` is an additional 49th view. It has seven additional
  authenticated privileges, and the same broad grants to anon, including
  non-SELECT privileges. Its inspected definition is only `SELECT 1 AS one`,
  its updatable mask is zero, and it has no custom trigger or rewrite rule.
  This is unresolved schema/grant drift, not a claim of financial exposure.
  No grant was revoked or view altered. Review disposition is still required.
- No public/storage policy expression references user-editable
  `user_metadata` or `raw_user_meta_data`.

### Executed database-only role and RLS checks

Six **REPEATABLE READ, READ ONLY** transactions used transaction-local SQL
role/subject context and ended with ROLLBACK. Four contexts selected the
already linked Owner, Manager, and two Secretary/Treasurer subjects internally;
the other contexts had no subject or a non-existent unlinked subject. No user
identifier, token, password, or raw financial row was exported. These are
**INDEPENDENT DATABASE-ONLY** checks, not hosted Auth logins, signed-JWT
verification, or evidence that the application's login guard was exercised.

Each context ran as the non-bypass `authenticated` SQL role with RLS active
and checked **107** capabilities: the 106 defined capabilities plus an unknown
capability that must be denied. All **642** evaluations matched the applicable
role union. SELECT counts covered all **76** public tables with authenticated
SELECT grants, for **456** table/context count checks.

Observed distinctions include:

- Owner can read audit rows; Manager and both Secretary/Treasurer contexts
  see zero audit rows.
- Each Secretary/Treasurer context sees only its own profile and role row,
  and zero client identity, guarantor identity, or loan identity snapshot rows.
- The no-subject context returns `no_session`; the unlinked-subject context
  returns `no_active_profile`. Both have no capabilities and no sensitive
  rows. The seven readable vocabularies include active repayment frequencies.
- All linked staff profiles have NULL branch scope, which the reviewed helper
  treats as global. The single existing branch cannot demonstrate cross-branch
  denial. No linked client role exists for a hosted borrower test.
- Zero-row benefit/meeting/document cases do not establish exercised data
  isolation for absent records. No mutating RPC or INSERT/UPDATE/DELETE was run.

**OPEN AUTHORIZATION-BOUNDARY FINDING:** the existing Manager and one
Secretary/Treasurer profile have `must_change_password = true`, yet
`current_session_context()` returns `ok`, normal role capabilities remain
available, and financial SELECTs return rows in their SQL-context checks.
The inspected `current_profile_id()` gates on active status, not this flag.
The application has a separate forced-change page guard; these results do not
exercise that guard or a hosted Data API request, and no financial write was
attempted. They do establish that the database authorization primitives do not
enforce the forced-change restriction. Do not mark full forced-change data-layer
isolation PASS. Explicit security review and an agreed enforcement decision
are required before closing that case; any remediation needs separately
reviewed work within an authorized scope. No account or production permission
was changed during this audit.

Suspended/inactive/no-role hosted session behavior, private object retrieval,
and signed-session API isolation remain unexecuted where existing approved
principals/data are unavailable. Production write-denial and transactional
separation-of-duty execution evidence remains the isolated CI suite and
matching catalog contracts; no production financial write was used as a test.

## Read-only financial reconciliation

The Phase 5 preservation snapshot at **19:15:37 EAT** again found 35 loans,
470 payments, savings = GL 2100 at UGX 1,010,000, principal = GL 1200 at
UGX 8,738,693, debit = credit at UGX 89,649,530, and zero unbalanced journals.
Policy 2.0 remained draft, unapproved, undated, unassigned, and disabled.

Audit count is now 1,670 rather than the earlier 1,668. A bounded read-only
query after the 18:49:47 EAT snapshot found one `auth.signed_in` and one
`auth.signed_out` event, with no financial event in that window. This does
not independently prove the user's browser scenarios or certify logout.
The older all-31 fingerprint comparison below remains point-in-time historical
evidence, not a claim that current authentication audit history is unchanged.

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

## Documentation and CI verification

The report and manual checklist are documentation-only changes on draft
[PR #17](https://github.com/JTREVORM/lending-manager/pull/17). Pinned Prettier
3.9.9 checks, local Markdown link/heading checks, evidence-label checks, and
restriction checks are required before the documentation commit. The repository's
existing CI jobs run on the resulting PR head; their exact outcomes are reported
in the PR Checks tab and release-verification response. Earlier CI passes are
not substituted for the new documentation revision. No workflow or required
check is bypassed, and this PR remains draft and unmerged.

## Certification decision and remaining work

**PARTIALLY VERIFIED; NOT OPERATIONALLY CERTIFIED.**

Merge, exact deployment identity, public health/readiness, anonymous route
protection, catalog security checks, read-only finance reconciliation, and
Policy 2.0 preservation have execution evidence. Post-merge CI is recorded
above. Basic Owner access now has USER-REPORTED manual evidence. The ten
remaining checklist groups above identify PENDING MANUAL, BLOCKED, and
partially checked database-only cases. The forced-change data-layer boundary
finding and the existing probe-view grant drift require explicit review.

Complete the applicable manual session checks privately with existing accounts,
record only sanitized observations, and resolve the blocked role/branch/client
coverage and security-review items before final Phase 5 certification. No
credential sharing, account change, production write test, migration, merge,
or deployment is authorized by this checklist.

This report is submitted in a separate documentation PR. That PR is not merged
and does not authorize another production deployment. Its source branch has
Vercel Git deployments disabled by the existing source configuration.

The earlier pre-release report and connectivity diagnosis are historical
evidence, not the current live-health decision. They remain available at the
[approved source revision](https://github.com/JTREVORM/lending-manager/blob/fc8f532b2c13dff68dfca045fcff95551b31141d/docs/POLYTOS-POST-RELEASE-CERTIFICATION.md)
and in `docs/POLYTOS-CONNECTIVITY-REMEDIATION.md`.
