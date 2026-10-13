# Phase 18 deployment — Step 2 record: production database migrations

Applied to Supabase project `fszgwemtgyrbhngajpzm` ("lending manager",
`eu-west-1`) on **2026-10-13**, between 18:03 and 18:20 UTC.

Authorised to proceed **without a database backup** on the owner's written
confirmation that production holds demo/testing data only. The recovery paths
are therefore Tier 1 (revert-in-place from git, which changes no data) and
platform PITR — see `DEPLOY-PHASE-18-PREFLIGHT.md` §9.

No branch was merged and no application deployment was triggered.

---

## 1. Pre-flight re-confirmation

Re-checked immediately before the first migration; **all four fingerprints and
every count identical to the preflight**, so nothing had moved in between.

| | Preflight | At apply time |
| --- | --- | --- |
| Server | PostgreSQL 17.11, `2a05:d018:…` (eu-west-1) | same |
| `fingerprint_policies` | `eda53ca479f2a3cfcb9b400cee0be55c` | same |
| `fingerprint_views` | `7c1112322141bf8c425d7a6af86f1e4b` | same |
| `fingerprint_functions` | `67d0269bf3d1b6a706f37fa924900995` | same |
| `fingerprint_columns` | `7bd18f98ca3982541ecb91cd2fa956cb` | same |
| Policies / tables / views / functions | 88 / 49 / 34 / 145 | same |
| Migrations applied | 99, last `20261016000200` | same |
| Health | 13/60 connections, 0 idle-in-txn, 0 long txn | same |

## 2. Migrations applied

All five succeeded, in the required order, each verified before the next.

| # | Version | Name | Result |
| --- | --- | --- | --- |
| 1 | `20261017000100` | `settings_reference_sequences` | applied |
| 2 | `20261018000100` | `rls_predicate_hoisting` | applied |
| 3 | `20261018000200` | `delinquency_pushdown` | applied |
| 4 | `20261018000300` | `session_context` | applied |
| 5 | `20261018000400` | `installment_coverage_pushdown` | applied |

Migration history: **99 → 104**, last version `20261018000400`.

### 2.1 A note on how they were recorded

`apply_migration` does not accept a version — it assigns its own wall-clock
value. Left alone, migration 1 was recorded as version `20261013180308` with
the file name in the `name` column, which is **exactly how the nine drift rows
in preflight §3.2 were created**: the repository's `20261017000100` would still
have looked unapplied, and a later `supabase db push` would have re-run it.

Each row's `version`/`name` was therefore corrected to the repository's
canonical values immediately after the DDL succeeded. Only the bookkeeping
columns were touched; the recorded `statements` and `created_by` are intact.
Verified afterwards: no wall-clock rows matching `^20261013(1[0-9]|2[0-3])…`
remain, and the five versions read exactly as the repository names them.

**No new drift was introduced.** The nine pre-existing drift rows from §3.2
were left alone — rewriting history that already matches the schema would be
change for its own sake.

## 3. Authorization and RLS verification

### 3.1 The rewrite landed exactly as verified

The decisive check. Migration 2 sets 81 policy predicates to absolute values,
so the only safe outcome is the one proved locally. A database built at
production's exact pre-state was migrated locally first to derive the expected
hash:

| | Value |
| --- | --- |
| Expected policy fingerprint (local, verified run) | `cbece47dd91bbc698924b5ede23f1370` |
| **Production after migration 2** | **`cbece47dd91bbc698924b5ede23f1370`** |

Production received a byte-identical transformation to the one covered by the
1,323-test database suite and the 574-probe visibility matrix.

Structural checks alongside it:

| Check | Result |
| --- | --- |
| Policy count | 88 → **88** (unchanged) |
| RLS-enabled tables | **49 of 49** |
| Column fingerprint | unchanged (`7bd18f98…`) |
| Policies with a bare per-row helper call | **0** |
| Policies naming neither a capability nor the caller's profile | **none** |
| `security_invoker=true` on all 10 derived views | **preserved** |

### 3.2 Behavioural verification against real production accounts

Production holds four staff accounts (one Owner/Administrator, one Manager,
two Secretary/Treasurer), all active, none branch-scoped, and no
borrower-linked profile. Each was impersonated read-only inside a rolled-back
transaction. Identified by role and id only — no names, phones or NINs.

| Acting as | clients | loans | payments | profiles | NINs | audit | sensitive snapshots |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Owner/Administrator | 28 | 35 | 470 | 4 | 28 | 1599 | — |
| Manager | 28 | 35 | 470 | 4 | 28 | **0** | — |
| Secretary/Treasurer | 28 | 35 | 470 | **1** | **0** | **0** | **0** |
| `authenticated`, no active profile | **0** | **0** | **0** | **0** | **0** | **0** | **0** |
| `anon` | refused at the grant level — `42501 permission denied` | | | | | | |

What each row proves:

- **Role permissions hold.** Manager can approve loans but cannot read the
  audit log or update settings. Secretary/Treasurer can take payments but
  cannot approve loans, read NINs, read the audit log, or read sensitive
  identity snapshots.
- **Borrower and staff privacy holds.** The Secretary/Treasurer sees **one**
  profile row of four — their own. That is the own-row clause
  (`id = (select current_profile_id())`) working through the hoisted
  predicate, which is the exact mechanism a bad hoist would have broken.
- **A suspended or unknown account sees nothing at all** — zero rows across
  every table and every derived view. `current_profile_id()` → NULL,
  `current_user_branch_id()` → NULL, `user_has_permission` → false. This is
  the case where hoisting could plausibly have leaked via NULL semantics; it
  does not.
- **Anonymous access is refused before RLS is even consulted**, because `anon`
  holds no table grant.

### 3.3 Branch isolation

No production profile is branch-scoped, so branch filtering cannot be
exercised against live rows. What was verified instead:

- `current_user_branch_id()` returns NULL for every production account, which
  selects the "not restricted to a branch" arm of the predicate — the same
  behaviour as before the migration, when `user_can_see_branch` returned true
  for an unscoped caller.
- The restated predicate was proved equivalent to `user_can_see_branch` over
  **every** combination of caller-branch and row-branch in
  `tests/db/rls-hoisting.test.ts`, which passes.

So branch isolation is correct by construction and by test, but is **not
exercised by production data today**. Worth re-checking the first time a
branch-scoped profile is created.

### 3.4 Policies that read as unconditionally true

Four, and all four are pre-existing and deliberate — the capability matrix and
the consent wording, readable by any authenticated caller:

`permissions_select_authenticated`, `role_permissions_select_authenticated`,
`roles_select_authenticated`, `guarantor_consent_terms_select_authenticated`.

The local baseline has the same four. They are among the seven policies
migration 2 deliberately does not touch.

## 4. The two new functions

| Check | Result |
| --- | --- |
| `current_session_context()` returns exactly one row | yes |
| …for the Owner | `outcome='ok'`, correct profile id, `role_keys={owner_admin}`, `status=active`, `must_change_password=false`, auth uid matches |
| …for a Secretary/Treasurer | `outcome='ok'`, `role_keys={secretary_treasurer}` |
| …for a token with no active profile | `outcome='no_active_profile'`, profile id NULL, roles empty, **name NULL — nothing leaked** |
| `settings_reference_sequences()` for a caller with `settings:view` | **8 rows** |
| …for a caller without it | `42501 permission denied for reference sequences` |
| `reference_sequences` table still unreadable to `authenticated` directly | yes |
| `anon` may execute either function | no |

**This closes the live defect from preflight §4.1.** The deployed build
(`557d898`, "Merge Settings reference counter access fix") already called
`settings_reference_sequences()`, which did not exist — so the Settings screen
has been reporting reference numbering as unavailable. It now returns data.

## 5. Financial controls — unchanged

Every row count and every control total re-compared against the preflight
baseline, twice (after migration 5, and again after `ANALYZE`).

**Count mismatches: none. Control-total mismatches: none.**

| Control | Preflight | After | |
| --- | --- | --- | --- |
| Clients / loans / payments | 28 / 35 / 470 | 28 / 35 / 470 | unchanged |
| Allocations / penalties | 522 / 5 | 522 / 5 | unchanged |
| Journal entries / lines | 565 / 1603 | 565 / 1603 | unchanged |
| Journal debit = credit | 88,499,530 | **88,499,530** | **balanced** |
| Trial balance debit = credit | 88,499,530 | **88,499,530** | **balanced** |
| Allocations total | 22,416,867 | 22,416,867 | unchanged |
| Penalties assessed | 860,589 | 860,589 | unchanged |
| Contractual outstanding | 10,337,070 | 10,337,070 | unchanged |
| Total outstanding | 11,156,222 | 11,156,222 | unchanged |
| Delinquency states | cleared 9, in_arrears 9, penalty_due 5, expired_unpaid 2, due_today 1 | identical | unchanged |

### 5.1 Derivation invariants

The checks that matter for the two view rewrites:

| Invariant | Result |
| --- | --- |
| Recorded penalties whose basis disagrees with `loan_outstanding_as_of` | **0 of 5** |
| Any loan whose `penalty_basis_as_of_grace_end` disagrees with the function | **0** |
| `days_past_due` ≠ business_date − oldest overdue date | 0 |
| `current_due` ≠ arrears + due today | 0 |
| `total_outstanding` ≠ contractual + penalty remaining | 0 |
| Loans whose installments do not sum to the contracted total | 0 of 26 |
| Coverage rows where allocated > expected | 0 |
| Coverage `remaining` ≠ expected − allocated | 0 |
| Coverage allocated total vs posted installment allocations | 22,245,430 = 22,245,430 |
| `loan_balances.total_paid` disagreeing with the coverage view | 0 |
| Allocation decomposition (principal + interest + penalty = total) | holds |

The first row is the important one: migration 3 replaced a per-loan call to
`loan_outstanding_as_of` with set-based arithmetic. The function is untouched
and is still what `ensure_penalty_applied` charges from, and for every penalty
actually recorded against a borrower the view and the function agree exactly.

### 5.2 All 34 views queryable

Probed individually; **none broken** by the two `create or replace view`
statements, including all eight dependents of `loan_delinquency`.

## 6. Database health and performance

| Check | Value |
| --- | --- |
| Connections | 13 of 60 |
| Idle in transaction / blocked queries | 0 / 0 |
| Longest transaction | 0 s |
| Deadlocks | 0 |
| Cache hit ratio | **99.99%** |
| Invalid indexes | none |
| WAL archive failures | **0** (last archive 18:17:29 UTC) |
| Database size | 22 MB |

### 6.1 RLS overhead, measured in production

The original defect was Row Level Security costing up to **203×** the query it
protected. Same reads, owner role (no policy) against `authenticated`:

| Read | Owner | `authenticated` | Multiplier |
| --- | --- | --- | --- |
| `loan_workflow_register` limit 21 | 45.7 ms | 121.3 ms | **2.7×** |
| `loan_delinquency` (whole book) | 20.4 ms | 80.2 ms | **3.9×** |
| `loan_installment_coverage` (all) | 4.4 ms | 23.1 ms | **5.3×** |
| `loan_aging` (all) | 45.1 ms | 151.0 ms | **3.3×** |
| `collections_today` | 132.2 ms | 121.2 ms | **0.9×** |

Authorization now costs roughly what an authorization boundary should.

`EXPLAIN (ANALYZE, BUFFERS)` on the register as `authenticated`: 21 rows,
**82.8 ms execution**, **19,142 shared buffers**. The pre-fix signature was
245,004 buffers on a *smaller* book.

### 6.2 Statistics — a production finding, fixed

Preflight §1.5 measured a 25× effect from missing planner statistics. The
health check found **31 of 49 tables had never been analyzed in production** —
including `profiles`, `user_roles`, `loan_periods`, `loan_penalties`,
`loan_schedules` and `ledger_accounts`, which feed the authorization and
derivation paths.

`ANALYZE` was run across the public schema. It reads the tables and writes
only to the statistics catalogues: **no business data altered, no exclusive
lock taken**. All 49 tables now have statistics; none remain unanalyzed.

Query times as `authenticated` afterwards:

| Read | ms |
| --- | --- |
| `loan_aging` (aging report) | 142.7 |
| `dashboard_portfolio_summary` | 120.1 |
| `collections_today` (collection sheet) | 115.8 |
| `loan_workflow_register` limit 21 (register) | 104.5 |
| `portfolio_at_risk` (Debt & Security) | 77.4 |
| `loan_delinquency`, one loan (detail page) | 45.3 |
| `current_session_context()` (every request) | **6.2** |
| `trial_balance` | 5.0 |

Control totals were re-verified **after** `ANALYZE`: still identical.

## 7. Advisories

The security advisor reports nothing introduced by this work:

- **`security_definer_view` (ERROR, 2)** — `company_identity` (deliberate
  since Phase 12: the borrower-safe identity view) and `__gate_probe` (the
  pre-existing stray from preflight §3.3). **Neither replaced view is
  flagged**, confirming `security_invoker` survived.
- **`rls_enabled_no_policy` (INFO, 3)** — `reference_sequences`,
  `reference_formats`, `rate_limit_counters`. Deliberate default-deny; that is
  precisely why `settings_reference_sequences()` exists.
- **`authenticated_security_definer_function_executable` (WARN, 39)** — the
  architecture: every gated write path is a `SECURITY DEFINER` function. Three
  of the 39 are new here, each internally gated or self-scoped.
- **Leaked password protection disabled (WARN)** — pre-existing Auth setting,
  unrelated to this work. Worth enabling separately.

## 8. Outstanding items

1. **No backup exists.** Accepted by the owner for demo data. Before this
   database holds real borrower money, take one — `DEPLOY-PHASE-18-PREFLIGHT.md`
   §5.2 has the command and §5.3 the restore drill.
2. **`__gate_probe`** is still present and still unmanaged. One line to drop,
   in its own migration, whenever convenient.
3. **Nine drift rows** (§3.2 of the preflight) remain. Harmless; cleaning them
   is cosmetic.
4. **Branch isolation is untested against live data** (§3.3).
5. **Leaked-password protection** is off in Supabase Auth.

None blocks the application deployment.

## 9. Verdict

**The database is ready for the application deployment.**

All five migrations are applied and recorded under their canonical versions.
The policy rewrite is byte-identical to the verified local run. Authorization
was checked behaviourally against every production account and holds, including
the cases where a bad hoist would have leaked. Every financial figure is
unchanged and both ledgers balance. All 34 views work. RLS overhead fell from
up to 203× to 1–5×, and the missing-statistics defect is fixed.

The ordering now matters: the database is **ahead** of the deployed build,
which is the safe direction. The migrations only add objects and make existing
predicates cheaper, so the current build keeps working. The new build must not
go out before these migrations — it calls `current_session_context()` on every
authenticated request — and that is now satisfied.
