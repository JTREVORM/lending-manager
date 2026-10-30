# POLYTOS post-release operational certification

Certification date: 30 October 2026 (Africa/Kampala).

**Decision: production operational certification is blocked.** The deployed
application's public readiness endpoint returns HTTP 503. The isolated regression
evidence and balanced production ledger do not override that runtime failure.

Review branch: `certification/polytos-post-release-2026-10-30`.
Review: [PR #16](https://github.com/JTREVORM/lending-manager/pull/16), left unmerged.
Final check conclusions and the exact tested revision are recorded in the PR's
verification record; do not substitute an earlier successful run for that revision.

## Released baseline and architecture

- Production/default branch: `claude/intelligent-knuth-2r8mpw`.
- Released commit: `84eafacd9d943bb62ae95ae86706f08738d1dde7`, merged through PR #15.
- [Post-merge CI](https://github.com/JTREVORM/lending-manager/actions/runs/41014796942)
  passed its checks/build, database and browser jobs.
- Vercel production deployment `dpl_HhheZDv77TctX4zq1xVg8sjrNQJb` is READY and
  resolves the production alias to that exact commit. READY is build/deployment
  metadata, not proof of healthy database connectivity.
- Supabase access was restricted to LENDING MANAGER,
  `fszgwemtgyrbhngajpzm`. Primary was not accessed.
- Source has 158 migrations; hosted history has all 158 plus nine historical
  timestamp variants. All 17 policy migrations
  `20261028000050` through `20261028001300` are present. Migration-history
  presence does not independently prove every hosted function is byte-identical.
- The implementation uses Next.js 16.4.1, React 19.3, TypeScript, Zod, Supabase
  SSR and PostgreSQL. Routes/components call server actions and data modules;
  domain calculations and validation are separate from presentation.
  PostgreSQL constraints, immutable records, RLS and capability-checked RPCs
  enforce financial operations. Money is integer UGX.
- Authentication verifies claims in the proxy, then resolves current profile,
  roles and capabilities through database session context. App writes use the
  signed-in client. Privileged clients remain restricted to explicit server
  administration paths.
- Roles are client, secretary/treasurer, manager and owner/administrator.
  Policy management and fine reversal are owner capabilities. Managers assess
  fines and review excuses; counter staff collect. Independent-person checks
  remain in database functions.
- Reviewed the implementation audit, architecture/authentication references,
  policy migrations, server actions, public-key validation, permission rules,
  database fixtures, CI and Playwright configuration. No system rebuild or
  duplicate financial module was introduced.

## Certification coverage

The following are exercised by the existing isolated suites, supplemented by the
new certification checks. Their run-level outcomes are in the verification
record on PR #16. These are not claims that hosted write workflows were executed.

1. **Membership and consent:** enrolment, fee and consent prerequisites,
   draft/future/superseded-policy rejection, immutable original terms,
   independently witnessed acceptance and controlled governing-policy transition.
   Evidence: `membership-enrolment`, `membership-hardening`, `memberships`,
   `rls-membership` and browser membership/policy suites.
2. **Savings:** multiple deposits in a month, the UGX 50,000 threshold, six
   qualifying months, gaps/consecutive rules, historical qualification and
   reversals. Ordinary approved/active loans also block withdrawals; payment
   rechecks the loan condition after approval. Evidence: `savings`,
   `rls-savings`, `policy-meeting-fines` and browser savings suites.
3. **Member lending:** 5% monthly flat pricing under specified policy terms,
   2x savings ceiling, conservative pledge rounding, eligibility, cadence,
   term limits, frozen pricing and TypeScript/PostgreSQL calculation parity.
   Evidence: `member-loan-eligibility`, `member-loan-approval`,
   `member-loan-security`, concurrency and calendar-month schedule suites.
4. **Unpaid installments:** idempotent concurrent carry-forward; contractual
   dates, installment amounts, allocations, arrears and ledger remain intact.
   Evidence: `policy-meeting-fines` and browser policy collection reporting.
5. **Medical benefits:** 5% of bill, integer rounding, evidence verification,
   separate assessment/approval, annual claim counting and explicit ceiling
   modes. Official Policy 2.0's undecided ceiling remains closed.
   Evidence: `policy-benefit-gates`, `benefit-claims`, `benefits-undecided`,
   accounting/concurrency suites and browser claims flows.
6. **Bereavement and condolence:** prior qualifying next-of-kin listing,
   three distinct other member confirmations, recorded verified recipient,
   assessment snapshots, and outstanding-loan payment blocks.
   Evidence: benefit claims, beneficiaries, benefit security and policy gates.
7. **Meetings and fines:** advance notice, independent excuse review,
   separation from attendance marking, UGX 5,000 charge, partial collection,
   idempotency, cancellation and contra reversal. Evidence:
   `policy-meeting-fines`, `meetings` and browser policy write flows.
8. **Accounting:** loan/savings/benefit/fine journals, allocations, receipts,
   immutability, reversals, as-of reporting, trial balance and upgrade
   preservation. Evidence: ledger, payment, reconciliation and financial
   upgrade suites; separate read-only hosted reconciliation below.
9. **Authentication and authorization:** all four roles, suspended/missing
   profiles, direct function access, ownership, branch scope, privilege
   escalation, anonymous access, private evidence and secret-free client
   bundles. The browser harness uses a local Auth shim; real hosted GoTrue
   login, session renewal and account recovery remain untested.
10. **Responsive UI:** existing desktop/mobile browser suites and four-width
    screenshot capture; new assertions cover 13 operational routes at desktop
    1440x900, mobile 390x844 and tablet 768x1024. Tablet also runs the five policy
    screen/authorization checks. Assertions check successful rendering,
    intended route, visible heading, no error boundary, no document overflow
    and no observed console/page errors. Chromium emulation does not certify
    physical devices or Safari/Firefox.
11. **Regression:** existing unit/integration, database, seeder and full browser
    suites are retained. No financial assertion or security grant was relaxed.
12. **Production:** deployment commit, migration inventory, RLS/grants, policy
    state, aggregate finances and table fingerprints were inspected read-only.
    Public HTTP probes tested login, readiness and five anonymous protected
    routes. No hosted payment, withdrawal, claim, fine or enrolment was posted.

## Executed evidence and failures

- [Database certification run](https://github.com/JTREVORM/lending-manager/actions/runs/41037880263/job/124003224897):
  1,781 database tests passed; seeder groups passed 18, 15, 24 and 25 tests.
  The same run's checks job failed formatting, so it is evidence for the
  successful database job only, not a successful entire run.
- The upgrade rehearsal preserved the original columns of 26 financial,
  identity and history tables, existing balances and approvals.
  Its artifact is `polytos-policy-financial-reconciliation`.
- Nine new isolation assertions failed against the old harness in
  [the reproduction run](https://github.com/JTREVORM/lending-manager/actions/runs/41024148070).
  Process execution was mocked: the reproduction made no database connection.
- Public smoke checks at 13:00 and 13:03 EAT returned six passes and one
  failure. Login returned 200 with CSP, no-store/private caching and nosniff.
  Anonymous access to policy transitions, loans, savings, benefits and
  finance/ledger returned 307 to login.
- `/api/health` returned 503 with `status=degraded`,
  `dataApi=unreachable`, `environment=production`, `version=0.1.0`.
  See [first smoke run](https://github.com/JTREVORM/lending-manager/actions/runs/41037537489)
  and [diagnostic repeat](https://github.com/JTREVORM/lending-manager/actions/runs/41037871618).
- In the matching probe window, Supabase edge logs recorded
  `HEAD /rest/v1/` -> 401, `UNAUTHORIZED_INVALID_API_KEY_TYPE`.
  Supabase project status was ACTIVE_HEALTHY and SQL read-only checks worked.
  This identifies a failure at API-key admission, before application data
  access; it does not establish the unreadable configured key's exact contents.
- Vercel runtime error/log queries returned no matching records in their
  selected recent windows. They do not negate the directly observed 503.
  Deployment-fetch connector access also failed; public GET evidence was
  obtained from GitHub Actions without credentials.
- Authoring environment startup failed and its later restart remained pending.
  Execution evidence comes from GitHub Actions, not claimed local execution.
  CI uses disposable loopback PostgreSQL and real PostgREST; the Auth service
  alone is shimmed.
- Interim lint/format failures were corrected without weakening tests.
  Expected red regression runs and cancelled superseded runs are not passes.

## Defects and proposed fixes

**CERT-01 — Unsafe test targets (high, fixed in the PR).**
A remote DATABASE_URL caused setup to warn and return, allowing the subsequent
write-heavy tests to continue against that target. Substring locality checks also
accepted localhost in credentials, a misleading hostname or query parameters.
The URL was interpolated into a shell command for psql.

The fix parses the URL, requires the configured loopback port/user/test database,
rejects password/query/fragment overrides, and fails before setup or pooled
connections. The database name must end in `_test` or `_e2e`. The psql URL is
passed as a literal argument. Browser configuration and rate-limit reset also
reject hosted targets. Missing DATABASE_URL still means an explicitly skipped
database suite, not a successful test run.

**CERT-02 — Privileged keys accepted as public configuration (high, fixed in the PR).**
The old validator rejected only strings beginning exactly with `sb_secret_`.
It accepted a legacy JWT with `role=service_role`, leading whitespace on a
secret key, and other malformed values. These must not be accepted into a
NEXT_PUBLIC variable.

The fix accepts modern publishable-key syntax or legacy JWTs whose decoded role
is `anon`. Existing rejection messaging for modern secret keys is preserved,
and errors do not echo configured values. This is key-type validation, not
cryptographic authentication: Supabase still validates authenticity and status.
Five rejection assertions failed against the old validator in
[run 41038825760](https://github.com/JTREVORM/lending-manager/actions/runs/41038825760),
while legacy-anon compatibility passed. Synthetic regression keys contain no
real credential. This finding does not
prove a privileged key is currently deployed.

**CERT-03 — Production Data API readiness failure (blocking, unresolved).**
A syntactically acceptable build and READY deployment are insufficient.
The production health probe reproducibly fails upstream key admission.
Vercel metadata contains the expected variable names, but the configured
publishable variable is stored as a sensitive, unreadable value. No environment
value was changed or redeployed. An authorized operator must verify the
production URL/key pairing for this exact LENDING MANAGER project, supply an
active publishable key, and perform a separately authorized deployment before
repeating health and authenticated smoke checks. Do not replace it with a
privileged key or weaken the health check.

## Security and deployment findings

- All 80 public tables have RLS enabled. All seven new policy tables deny anon
  SELECT and direct authenticated INSERT/UPDATE/DELETE.
- No public SECURITY DEFINER function is executable by anon; all inspected
  public definers pin an empty search path. Hosted policy capabilities match
  the intended role distribution.
- Supabase reports 117 authenticated SECURITY DEFINER executable-function
  warnings. Privileged transactional RPCs are deliberate architecture, with
  capability, branch and state checks; the warning count is not an exploit
  count or a substitute for negative-role tests.
- `company_identity` is a documented definer-view exception. Its projection
  contains published company identity/contact fields, excludes tax and
  registration identifiers, and is readable only by authenticated users.
- Hosted `public.__gate_probe` is absent from source and readable by anon.
  Its definition is only `SELECT 1 AS one`; no financial or identity data is
  exposed by that definition. Record and review this low-impact schema drift.
  It was not deleted or altered.
- Leaked-password protection is disabled: an outstanding hardening finding,
  not a demonstrated account compromise.
  [Supabase remediation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- Vercel metadata scopes the same Supabase URL, publishable-key and secret-key
  entries to both production and preview. Do not enable certification previews
  against hosted production finances. Separate preview credentials/data are
  needed before future write testing there. Secret values were not exported.
- This branch disables its own Vercel Git deployments. Listing deployments for
  the branch returned none. The production alias still references the release
  commit. Supabase Preview checks were skipped.
- The production branch was reported unprotected. Branch/ruleset governance is
  an operational review item; no repository protection setting was changed.
- Performance advisors reported 143 unindexed foreign keys and 124 unused
  indexes (informational). No speculative index changes or production load
  tests were performed on the small demo dataset.
  [Index advisor reference](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).

## Read-only production reconciliation

Amounts below are UGX. SQL used READ ONLY transactions; reconciliation and
fingerprints used consistent snapshots. The captures are point-in-time
comparisons, not a restorable backup or a physical cash count.

- Clients 28; loans 35; installments 719; loan receipts 470.
- Posted receipts 469 totaling 22,286,867; one reversed receipt retains its
  historical amount of 130,000.
- Memberships 6; savings accounts 5; savings transactions 26.
- Savings subledger = GL 2100 = **1,010,000**.
- Loan principal remaining = GL 1200 = **8,738,693**.
- Outstanding principal 8,738,693 + interest 1,598,377 + penalties 819,152 =
  total loan outstanding **11,156,222**.
- Journal debit = credit = **89,649,530**.
- Journals 597; journal lines 1,667; unbalanced journals **0**.
- Journals without lines **0**; savings transactions missing journals **0**.
- Negative loan balance components **0**; posted-receipt/allocation mismatches **0**.
- Benefit payments **0**; fine payments **0**. Zero rows are not evidence of
  a successfully executed live benefit/fine workflow.
- All 31 captured table counts and sorted-JSON MD5 fingerprints matched
  between the earlier and later certification snapshots. This includes
  financial tables, original terms, reference sequences, policies and all
  1,668 audit rows. MD5 is used only as a consistency fingerprint.
- Policy 2.0 remains **draft, unapproved, undated**, with **zero assignments**.
  Medical ceiling mode and profit distribution remain NULL. Legacy demo
  policy 999.0 remains active; it was not replaced or deleted.

The isolated upgrade fixture is a different dataset: 17 loans, 161 historical
payments, savings/GL 2100 of 1,790,000 and journal debits/credits of 17,700,523.
These figures match the release-run and fresh verifier logs. Older interim
figures in the implementation audit (167 payments and 17,776,274) must not be
reported as the final fixture or as hosted production totals.

## Remaining certification gates

1. Resolve CERT-03 through authorized production configuration/release work,
   then obtain successful readiness and real authenticated session evidence.
2. Require the final PR's checks/build, database and browser jobs to pass.
   Keep the public production failure visible until it is actually resolved.
3. Test hosted Auth-specific login, refresh, recovery and role behavior using
   an approved isolated environment or authorized test accounts. Local Auth
   shim results do not certify the hosted identity provider.
4. Review leaked-password protection, shared preview/production environment
   scoping, the extra probe view, legacy migration-history variants and branch
   protection. No settings or hosted schema were changed during this audit.
5. Leave Policy 2.0 inactive. Its medical ceiling, activation timing and any
   future profit distribution require separate business decisions. This
   certification supplies none of those approvals.
6. Preserve all hosted demo records. No cleanup, merge, deployment, production
   migration or financial write was performed. PR #16 remains unmerged.

## Reproduction

Use the repository's disposable local cluster or GitHub Actions. Never supply
hosted database credentials to test commands.

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:run
npm run audit:money
npm run db:local:setup
DATABASE_URL=postgresql://lending@localhost:5433/lending_test npm run test:db
node scripts/verify-membership-upgrade.mjs
bash tests/e2e/harness/stack.sh up
source <(bash tests/e2e/harness/stack.sh env)
npx playwright test
bash tests/e2e/harness/stack.sh down
```

The existing CI also performs the production dependency audit, source/history
secret scan, production build and built-browser-bundle assertions.
`scripts/certify-production-readonly.mjs` is a separate, explicitly public,
credential-free GET probe and writes only a sanitized local evidence file.
