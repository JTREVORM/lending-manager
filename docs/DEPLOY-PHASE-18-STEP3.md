# Phase 18 — Step 3: production application deployment

Step 1 verified the production target and recorded the baseline
(`DEPLOY-PHASE-18-PREFLIGHT.md`). Step 2 applied the five migrations
(`DEPLOY-PHASE-18-STEP2.md`). This step merged the application code and
deployed it.

| | |
| --- | --- |
| Pull request | [#7](https://github.com/JTREVORM/lending-manager/pull/7) |
| Source branch | `claude/dreamy-albattani-dwlriz` @ `47af8b2` |
| Target branch | `claude/intelligent-knuth-2r8mpw` |
| Merge commit | **`5fe88c95730f10b7e7fa1fd19e1df606827499ca`** |
| Deployment | `dpl_DweXDZRsn8rdQmrqt6abiP7CHFm8` |
| Production URL | <https://lending-manager-ten.vercel.app> |
| Region | **`dub1`** (was `iad1`) |
| Database | `fszgwemtgyrbhngajpzm`, 104 migrations, unchanged by this step |
| Verdict | **deployed and verified, with two gaps recorded in §7** |

---

## 1. Pre-merge state

Source branch current and clean: working tree empty, local `HEAD` equal to
`origin/claude/dreamy-albattani-dwlriz` at `47af8b2`, nothing unpushed, five
commits ahead of the target. The target was an ancestor of the source, so the
merge could not conflict.

All five migrations were confirmed present in
`supabase_migrations.schema_migrations` before anything was merged:

| Version | Name |
| --- | --- |
| `20261017000100` | `settings_reference_sequences` |
| `20261018000100` | `rls_predicate_hoisting` |
| `20261018000200` | `delinquency_pushdown` |
| `20261018000300` | `session_context` |
| `20261018000400` | `installment_coverage_pushdown` |

`current_session_context()` and `current_user_branch_id()` are both live,
both `SECURITY DEFINER`, both executable by `authenticated` and **not** by
`anon`. Called on the production connection, `current_session_context()`
returns exactly one row — `no_session`, null subject, empty `text[]` — which
is the contract `lib/auth/context.ts` switches on.

## 2. Checks at merge

| Job | Source `47af8b2` | Base `557d898` |
| --- | --- | --- |
| checks, unit/integration, build | **success** | success |
| database (real PostgreSQL, migrations from zero) | **success** | success |
| browser E2E | failure | **failure, identically** |

`checks` covers typecheck, lint, format, 2,174 unit/integration tests, the
money arithmetic audit, the secret scan over full history, the production
dependency audit, the production build and the client-bundle secret scan.
`database` applies every migration from zero and runs 1,323 tests. Both were
green on the PR event as well as on the branch push.

### 2.1 The one red check, and why it was not a blocker

`browser E2E` fails on the source branch **and identically on the base
branch**, which was already deployed to production:

```
4 failed
  [setup] › tests/e2e/specs/auth.setup.ts:40:9 › sign in once per role › owner
  [setup] › tests/e2e/specs/auth.setup.ts:40:9 › sign in once per role › manager
  [setup] › tests/e2e/specs/auth.setup.ts:40:9 › sign in once per role › secretary
  [setup] › tests/e2e/specs/auth.setup.ts:40:9 › sign in once per role › borrower
519 did not run
2 passed (1.9m)
```

Byte-for-byte the same shape in both runs: all four sign-ins time out on
`page.waitForURL` at `/login`, so the 519 real specs never execute. **Zero
spec failures** — nothing in the suite actually disagrees with the code. It is
an environment-level condition in the GitHub Actions harness, present on the
production branch before this branch existed, and the same suite is green on
the same harness locally (498 passed, 27 skipped — `PERFORMANCE.md` §6.1).

It was therefore not introduced here and there was no fix to port. It is
recorded as an open item in §7 rather than carried silently.

## 3. Deployment

Vercel picked up the merge commit automatically — no manual trigger:

```
dpl_DweXDZRsn8rdQmrqt6abiP7CHFm8
  githubCommitSha  5fe88c95730f10b7e7fa1fd19e1df606827499ca
  githubCommitRef  claude/intelligent-knuth-2r8mpw
  target           production
  regions          ["dub1"]
  state            READY        (built in 78 s)
  aliasError       null
```

The previous production deployment (`dpl_AhbFhETnLTBpCUFXnSyvsA6ewbu8` @
`557d898`) remains a rollback candidate, which is the rollback path if one is
ever needed.

### 3.1 Region

`vercel.json` pins `dub1`, the Vercel region in the same AWS region as the
`eu-west-1` database. Confirmed twice: in the deployment metadata above, and
at the HTTP layer, where a rendered page answers with

```
x-vercel-id: iad1::dub1::rtlh4-...
```

The first field is the edge that accepted the request (`iad1`, because the
measuring client egresses near Washington); the second is where the function
ran — **`dub1`**. Before this deployment the same header read `iad1::iad1::`.

## 4. Production performance

### 4.1 Over HTTP

Median of seven requests per path against
`lending-manager-ten.vercel.app`, immediately before the merge and immediately
after the deployment became READY. Same client, same method.

| Path | Before (`iad1`) | After (`dub1`) | |
| --- | --- | --- | --- |
| `/login` — renders server-side | 650 ms | **402 ms** | −38% |
| `/` and nine protected routes — `307` | 188–215 ms | 177–227 ms | unchanged |

Only `/login` renders a page without a session, so it is the only route whose
server-side work this comparison can see. The redirects are unchanged **by
design**: with no session cookie the proxy redirects without touching the
database, so they measure edge round trip only, and the edge did not move.

The honest reading of the region change: it adds about 75 ms of transatlantic
distance between the `iad1` edge and the function, and removes about 80 ms
from *every* database round trip the function makes. A page that issues
several queries wins; a page that issues none does not. `/login` improving by
248 ms while the pure redirects stayed flat is consistent with exactly that.

### 4.2 At the database, as Owner/Admin

Measured on the production database with `EXPLAIN (ANALYZE, BUFFERS)` while
impersonating the production Owner/Admin, against production data
(28 clients, 35 loans, 470 payments, 1,603 journal lines).

| Screen | Object | Execution | Shared buffers | Rows |
| --- | --- | --- | --- | --- |
| Reports (aging) | `loan_aging` | 108.6 ms | 29,004 | 17 |
| Dashboard | `dashboard_portfolio_summary` | 108.3 ms | 28,464 | 1 |
| Loans | `loan_workflow_register` | **75.9 ms** | 18,647 | 35 |
| Collections | `loan_delinquency` | 66.3 ms | 18,452 | 26 |
| Finance | `payment_register` | 26.4 ms | 2,177 | 470 |
| Notifications | `notification_summary` | 18.9 ms | — | 117 feed |
| Finance | `trial_balance` | 4.4 ms | 551 | 27 |
| Clients | `clients` | 2.9 ms | 513 | 28 |

Against the pre-fix signature for the loan register — 20,524
`user_has_permission` invocations and 245,004 shared buffers for fourteen
rows — this is 18,647 buffers for thirty-five rows and, across **every** plan
above, **zero** per-row function scans of `user_has_permission`,
`current_profile_id` or `user_can_see_branch`.

### 4.3 The fix, visible in the plan

This is the clearest single piece of evidence. The `clients` plan:

```
Seq Scan on clients (actual time=2.743..2.758 rows=28 loops=1)
  Filter: ((((profile_id IS NOT NULL) AND (profile_id = (InitPlan 1).col1))
             OR (InitPlan 2).col1)
           AND ((branch_id IS NULL) OR ((InitPlan 3).col1 IS NULL)
             OR (branch_id = (InitPlan 4).col1)))
  InitPlan 1 -> Result (never executed)
  InitPlan 2 -> Result (actual time=2.423..2.424 rows=1 loops=1)
  InitPlan 3 -> Result (actual time=0.291..0.291 rows=1 loops=1)
  InitPlan 4 -> Result (never executed)
Execution Time: 2.898 ms
```

Three things to note. The predicate is the restated branch check exactly as
`20261018000100` writes it. Every helper is an `InitPlan` evaluated at most
`loops=1` — once per statement, not once per row. And two of the four are
`never executed` at all, because the capability term short-circuits the
own-profile term and a null caller branch short-circuits the branch
comparison.

`trial_balance` shows the same thing over 1,603 rows: `Filter: (InitPlan
2).col1` on the `journal_lines` scan, with the `InitPlan` run once.

### 4.4 The two documented exceptions

`notification_summary`'s plan still shows two bare calls, both deliberate and
both already covered by `tests/db/rls-hoisting.test.ts`:

- `user_has_permission(audience_permission)` takes a **column** as its
  argument. It is correlated, so it cannot be hoisted, and the test
  explicitly whitelists this one call.
- `notification_reads_select_own` is the single policy of the eighty-one that
  names no capability; it is scoped to the reader's own profile and named none
  before the rewrite either.

## 5. Roles and permissions, live

Verified by impersonating each production account against the objects behind
the eight screens. Production holds four accounts: one Owner/Admin, one
Manager, two Secretary/Treasurer.

| | Owner/Admin | Manager | Secretary/Treasurer | Valid token, no profile | `anon` |
| --- | --- | --- | --- | --- | --- |
| `current_session_context()` | `ok` | `ok` | `ok` | `no_active_profile` | no EXECUTE |
| Clients | 28 | 28 | 28 | **0** | denied `42501` |
| Loans register | 35 | 35 | 35 | **0** | denied `42501` |
| Delinquency | 26 | 26 | 26 | **0** | — |
| Collections today | 7 | 7 | 7 | — | — |
| Trial balance | 27 | 27 | 27 | **0** | — |
| General ledger | 1,603 | 1,603 | — | **0** | — |
| Payment register | 470 | 470 | 470 | **0** | denied `42501` |
| Report: aging | 17 | 17 | 17 | — | — |
| Notification summary | 1 | 1 | 1 | — | — |
| Notification feed | 117 | — | — | **0** | — |
| Settings: profiles | 4 | 4 | **1** | **0** | denied `42501` |
| Settings: sequences | 8 | — | — | — | — |
| `users:view` | — | true | **false** | — | — |
| `payments:record` | — | — | **false** | — | — |

Three rows carry the weight:

1. **A Secretary/Treasurer sees one profile of four — their own — and holds
   no `users:view`.** The policy is `id = current_profile_id() OR
   user_has_permission('users:view')`, and hoisting both terms must not have
   widened it. It did not. This is precisely the mechanism a bad hoist would
   break.
2. **A validly-signed token for a subject with no profile sees zero rows on
   every table and view**, and both `current_profile_id()` and
   `current_user_branch_id()` return null. This matters because the restated
   branch predicate contains `(select current_user_branch_id()) is null or
   ...`, which would be a leak if the capability term did not gate it. It
   does.
3. **`anon` is refused at the grant level** (`42501 permission denied`),
   before RLS is consulted at all — the strongest available denial, and it
   holds no EXECUTE on either new function.

`settings_reference_sequences()` returns eight rows, so the live Settings
defect that preflight §4.1 found — the deployed build calling a function that
did not exist, leaving reference numbering reported as unavailable — is
resolved.

The Manager account carries `must_change_password = true`, correctly reported
through `current_session_context()`; in the live application that account is
held at the password form until it is changed, which is the intended
behaviour and not a fault.

### 5.1 Authentication over HTTP

What can be checked without holding a password was checked:

| Probe | Result |
| --- | --- |
| Protected route, no cookie | `307 → /login?next=...` |
| Protected route, garbage cookie | `307 → /login?next=/dashboard` |
| Protected route, **forged unsigned JWT naming a real subject** | `307 → /login?next=/loans` |

The third is the one worth stating plainly: a token carrying a genuine
production subject but no valid signature does not get in. The new
single-round-trip auth path verifies the token rather than trusting its
claims — the proxy refreshes and verifies the session, and PostgREST verifies
the signature again before `auth.uid()` has any value.

## 6. Financial controls — unchanged

Compared against the preflight baseline immediately before the merge and
again after the deployment was live. **No count and no control total
differs.**

| Control | Preflight | Pre-merge | Post-deploy |
| --- | --- | --- | --- |
| Clients / loans / payments | 28 / 35 / 470 | 28 / 35 / 470 | 28 / 35 / 470 |
| Allocations / penalties | 522 / 5 | 522 / 5 | 522 / 5 |
| Journal entries / lines | 565 / 1603 | 565 / 1603 | 565 / 1603 |
| Journal debit = credit | 88,499,530 | 88,499,530 | **88,499,530** |
| Allocations total | 22,416,867 | 22,416,867 | 22,416,867 |
| Penalties assessed | 860,589 | 860,589 | 860,589 |
| Total outstanding | 11,156,222 | 11,156,222 | 11,156,222 |
| Delinquency states | cleared 9, due_today 1, expired_unpaid 2, in_arrears 9, penalty_due 5 | identical | identical |
| RLS policies | 88 | 88 | **88** |
| Policy fingerprint | — | `6dd2cb2bea6f…` | **`6dd2cb2bea6f…`** |
| `security_invoker` views | 32 | 32 | 32 |
| Migrations applied | 104 | 104 | **104** |

Both ledgers balance. The policy fingerprint is identical across the
deployment, so nothing about authorization moved. The migration count is
identical, so **no migration was reapplied** — this step changed application
code only and made no schema change whatsoever.

Vercel reports **no runtime errors in the preceding 24 hours** and no runtime
log entries for the new deployment: no authentication, permission, database
or application errors.

## 7. What is not verified, and why

Two gaps. Neither is a fault found in the deployment; both are things this
session could not reach.

1. **No browser session was driven as the four roles.** The application
   requires a password and this session holds none. Every role claim in §5 is
   proved at the database, through the same policies and the same
   `current_session_context()` the pages use, by impersonating each real
   production account — but nobody clicked through Dashboard, Clients, Loans,
   Collections, Finance, Reports, Notifications and Settings in a browser.
   What that would add beyond §5 is the rendering layer: that each screen
   composes and paints without a client-side error. To close it, sign in once
   per role and walk the eight screens; or share a credential and it can be
   driven and measured here.

   Related: forging a session cookie would have closed this gap cheaply and
   was deliberately not done. The whole point of §5.1 is that unverified
   tokens are rejected, and manufacturing one to get past the gate would have
   meant weakening the thing under test.

2. **There is no borrower account in production.** Not a credential problem —
   the account does not exist. Four `auth.users`, four profiles, all staff;
   zero `client` role rows; none of the 28 clients is linked to a profile. So
   borrower authentication and the portal cannot be tested in production as it
   stands, by anyone, until a borrower login is created. The borrower paths
   are covered by the local browser suite and by the RLS suites.

Carried forward unresolved from Step 2, unchanged by this step:

3. **No database backup exists.** Accepted by the owner for demo data.
   Before this database holds real borrower money, take one —
   `DEPLOY-PHASE-18-PREFLIGHT.md` §5.2 has the command, §5.3 the restore
   drill.
4. **`browser E2E` is red in CI** on the production branch, as described in
   §2.1. Red before this work and red after it; zero spec failures. Worth
   fixing on its own, because while it is red the branch protection it ought
   to provide is absent.
5. **`__gate_probe`** remains — a `SELECT 1` view present in production and in
   no migration, found by preflight §3.3, not created by this work. One line
   to drop, in its own migration.
6. **Nine migration-history drift rows** remain. Harmless; cleaning them is
   cosmetic.
7. **Branch isolation is untested against live data**: every production
   profile has `branch_id` null, so the branch term of every policy is
   short-circuited in production and cannot be exercised there. It is covered
   locally by `rls-hoisting.test.ts`, which proves the restated predicate
   agrees with `user_can_see_branch` over every combination of caller branch
   and row branch.

## 8. Rollback

If the deployment needs to be withdrawn: promote
`dpl_AhbFhETnLTBpCUFXnSyvsA6ewbu8` (`557d898`), which is still a rollback
candidate. The database needs no rollback and must not be rolled back — every
Phase 18 migration is additive, and the previous build runs against it
unchanged, which is why the database was deliberately moved first. The only
behaviour the old build loses is `current_session_context()`, which it never
called.
