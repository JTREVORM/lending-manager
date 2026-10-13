# Phase 18 deployment — Step 1 preflight record

Read-only preflight for the Phase 18 performance migrations. **Nothing was
changed in production by this step**: no schema change, no data change, no
migration applied, no branch merged, no deployment triggered. Every statement
below was a `SELECT` against the catalogue or an aggregate.

Captured **2026-10-13 17:40:09 UTC**.

---

## 1. Production target — confirmed

| | |
| --- | --- |
| Project ID / ref | `fszgwemtgyrbhngajpzm` — **matches the expected ID** |
| Project name | `lending manager` |
| Organization | `udrfljoqkwwgsrionoad` |
| Region | `eu-west-1` (AWS, Ireland) |
| Database host | `db.fszgwemtgyrbhngajpzm.supabase.co` |
| Engine | PostgreSQL 17.11 (`17.11.0.003`, release channel `ga`) |
| Status | `ACTIVE_HEALTHY` |

Verified from inside the session, not just from the project listing:

```
current_database() = postgres
current_user       = postgres
inet_server_addr() = 2a05:d018:1b65:3000:... (AWS eu-west-1 range)
version()          = PostgreSQL 17.11 on aarch64-unknown-linux-gnu
```

**Mis-target risk noted:** the same organization contains a second project,
`nmdyyhkwmsnhfhfivoji` ("salongohamuza's Project", `eu-central-1`). Every
command in Step 2 must carry `project_id=fszgwemtgyrbhngajpzm` explicitly.

## 2. Connectivity and health — good

| Check | Value |
| --- | --- |
| Uptime since | 2026-10-06 13:16:33 UTC |
| Database size | 22 MB |
| Connections | 13 of 60 |
| Idle in transaction | 0 |
| Longest running transaction | 0 s |
| `archive_mode` / `wal_level` | `on` / `logical` |
| WAL segments archived | 242, **0 failures** |
| Last WAL archive | 2026-10-13 12:23:16 UTC |
| Replication slots | none |
| RLS enabled | **49 of 49** tables |

No long transactions and no idle-in-transaction sessions, so the `ALTER
POLICY` and `CREATE OR REPLACE VIEW` statements in Step 2 will not queue
behind a lock.

## 3. Migration history — production vs repository

- Production: **99 migrations applied**, latest `20261016000200`
- Repository (`claude/dreamy-albattani-dwlriz` @ `4271740`): **95 migrations**
- Matched on both sides: **90**

### 3.1 Pending — 5 migrations

| Version | Name | Note |
| --- | --- | --- |
| `20261017000100` | `settings_reference_sequences` | **Not applied.** See §4 — this is not merely pending, its absence is a live defect. |
| `20261018000100` | `rls_predicate_hoisting` | Pending, as expected |
| `20261018000200` | `delinquency_pushdown` | Pending, as expected |
| `20261018000300` | `session_context` | Pending, as expected |
| `20261018000400` | `installment_coverage_pushdown` | Pending, as expected |

Confirmed from the database, not inferred: `count(*) filter (where version >=
'20261017') = 0`.

Phase 18's own objects are confirmed absent (`current_user_branch_id` = 0,
`current_session_context` = 0), so none of these migrations has partially
applied.

### 3.2 Drift — 9 migrations applied in production, absent from the repository

| Version | Name | Repository equivalent |
| --- | --- | --- |
| `20261010104426` | `collateral` | `20261014000100` |
| `20261010104529` | `recovery_actions` | `20261014000200` |
| `20261010104621` | `guarantee_release` | `20261014000300` |
| `20261010104723` | `risk_monitoring` | `20261014000400` |
| `20261011060140` | `notifications` | `20261015000100` |
| `20261011060324` | `notification_triggers` | `20261015000200` |
| `20261011061348` | `notification_backfill` | `20261015000300` |
| `20261012062453` | `balance_as_of` | `20261016000100` |
| `20261012064058` | `notify_what_still_waits` | `20261016000200` |

Every one of the nine has a same-named counterpart that is *also* recorded as
applied. The signature is an earlier `supabase db push` that stamped
wall-clock versions, after which the repository renumbered the same files into
the planned phase sequence and they were applied a second time under the new
versions. Both runs succeeded, which is only possible because the DDL is
idempotent (`create or replace`, `if not exists`).

**Assessed as benign history drift, not schema drift** — and that assessment
is measured rather than assumed, in §3.3.

### 3.3 Schema drift — none that affects Phase 18

A local database was built by applying the repository's migrations up to and
including `20261016000200` — exactly production's migration state — and
fingerprinted against production with identical SQL on both sides:

| Object set | Baseline | Production | Result |
| --- | --- | --- | --- |
| 88 policy names + commands + expressions | `eda53ca4…` | `eda53ca4…` | **identical** |
| `loan_delinquency`, `loan_installment_coverage` definitions | `9f35bb4b…` | `9f35bb4b…` | **identical** |
| Their column lists, order and types | `c8b35bb0…` | `c8b35bb0…` | **identical** |
| The 7 functions Phase 18 reads or replaces | `52a9aa35…` | `52a9aa35…` | **identical** |
| Set of views in `public` | `f7de59ac…` | `ea3cd0d6…` | **one difference** |

This is the check that decides whether Step 2 is safe, because
`20261018000100` sets **81 policy predicates to absolute new values** rather
than patching them. Production's current predicates being byte-identical
(after whitespace normalisation) to the baseline those statements were
generated from means the rewrite will land on exactly the predicates it was
derived from — not on something that has since diverged.

The one view difference is `__gate_probe`, which exists in production and in
no migration:

```sql
 SELECT 1 AS one;
```

Owned by `postgres`, depends on nothing, selects no table, and exposes only
the constant `1`. It is leftover connectivity-probe scaffolding. It does not
depend on, and is not depended on by, anything Phase 18 touches. **Not a
blocker and not a data-exposure risk**; worth dropping in a later tidy-up
migration so the schema matches the repository, which is a separate decision
from this deployment.

### 3.4 Policy targets — all present

`20261018000100` names 81 policies. Production has 88 policies; **all 81
targets exist**, none missing. The 7 it does not touch are exactly the 7
identified during development as calling no authorization helper:

`guarantor_consent_terms_select_authenticated`, `loan_periods_select_with_loan`,
`payment_allocations_select_with_payment`, `permissions_select_authenticated`,
`repayment_frequencies_select_authenticated`, `role_permissions_select_authenticated`,
`roles_select_authenticated`.

## 4. Prerequisites

Everything Phase 18 reads or replaces is present in production:

| Object | Present |
| --- | --- |
| `user_has_permission(text)` | yes |
| `current_profile_id()` | yes |
| `user_can_see_branch(uuid)` | yes |
| `current_user_role_keys()` | yes |
| `loan_outstanding_as_of(uuid,date)` | yes |
| `business_date()`, `payment_business_date(timestamptz)` | yes |
| `loan_delinquency`, `loan_installment_coverage` views | yes |

### 4.1 `20261017000100` is a live production defect, not just a pending migration

It is **not applied**, and `public.settings_reference_sequences()` does not
exist in production (`count = 0`).

That function is called by the application:

```
lib/data/settings.ts:128    supabase.rpc('settings_reference_sequences')
```

The currently deployed production build is `557d898` on
`claude/intelligent-knuth-2r8mpw` — whose commit message is *"Merge Settings
reference counter access fix"*. So the deployed code already calls a function
its migration never created.

The failure is graceful, not an outage: the error is caught, logged, and
`unavailable.push('sequences')` makes the Settings page report that section as
unreadable. **Effect today: the Settings screen shows reference numbering as
unavailable to Owner/Administrator.** Applying `20261017000100` fixes it.

It is **not** a technical prerequisite for Phase 18 — it only creates one
function and its grants, touching no policy, view or table that Phase 18
depends on. It should nonetheless go first, in version order.

## 5. Backup — NOT COMPLETED. This is the blocker.

**I could not create a production backup, and I did not attempt a workaround.**
Three independent reasons, each sufficient on its own:

1. **No production database credentials exist in this environment.** No
   `DATABASE_URL`, no `PG*`, no `SUPABASE_*` variables, and no `.env` file
   (only `.env.example`). The Supabase MCP channel is a managed HTTPS API, not
   a libpq connection `pg_dump` can use.
2. **Client/server version mismatch.** This container has PostgreSQL **16.15**
   client tools; production is **17.11**. `pg_dump` refuses to dump a server
   newer than itself.
3. **No network path.** `db.fszgwemtgyrbhngajpzm.supabase.co` does not resolve
   from this container and the pooler on `6543` is unreachable. Outbound
   access is restricted to the agent HTTPS proxy.

I deliberately did not pursue the alternative of exporting every row through
`execute_sql`. It would pull borrower names, phone numbers, national ID
numbers and full financial history through this session's tool output, which
breaches the instruction not to expose sensitive customer data — and the
result would be JSON in a transcript, not a restorable backup.

### 5.1 What *is* in place

WAL archiving is healthy (`archive_mode=on`, 242 segments, **0 failures**,
last archive 12:23:16 UTC). That is the substrate Supabase's managed
backups and point-in-time recovery run on, and it is working.

**But WAL health is not a verified backup.** Supabase backup existence,
schedule, retention and PITR window are platform-level facts visible on the
project's Database → Backups page and are not exposed by the tools available
here. I cannot confirm a restorable backup exists, so I am not claiming one
does.

### 5.2 The backup to run before Step 2

Run this from a machine that has the production credentials and a PostgreSQL
**17** client. Never paste the password on a command line — let `pg_dump`
prompt, or use `~/.pggpass`.

```bash
# PostgreSQL 17 client, matching the server major version.
pg_dump --version        # must report 17.x

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="polytos-prod-${STAMP}.dump"

umask 077                # the dump contains customer financial data

# Custom format: compressed, selectively restorable, parallel-restorable.
# --no-owner/--no-privileges keep it restorable into a fresh project whose
# role names differ.
pg_dump \
  --host=db.fszgwemtgyrbhngajpzm.supabase.co \
  --port=5432 \
  --username=postgres \
  --dbname=postgres \
  --format=custom \
  --compress=9 \
  --no-owner --no-privileges \
  --verbose \
  --file="${OUT}"

sha256sum "${OUT}" > "${OUT}.sha256"
```

Take it against the **direct host on 5432**, not the transaction pooler on
6543 — the pooler does not support the session-level operations `pg_dump`
needs.

### 5.3 Verifying it — a dump you have not restored is not a backup

```bash
# 1. The archive is internally complete and readable.
pg_restore --list "${OUT}" > "${OUT}.toc"
wc -l < "${OUT}.toc"                       # expect many hundreds of entries
grep -c "TABLE DATA" "${OUT}.toc"          # expect ~49 tables with data

# 2. The checksum matches.
sha256sum -c "${OUT}.sha256"

# 3. Restore into a throwaway database and compare control totals.
createdb restore_check
pg_restore --dbname=restore_check --no-owner --no-privileges --jobs=4 "${OUT}"
psql -d restore_check -c 'analyze'
```

Then re-run the §7 control-total query against `restore_check` and confirm
every figure matches this document. In particular both ledgers must still
balance at **88,499,530**. Drop `restore_check` afterwards.

**Do not proceed to Step 2 until step 3 above has actually been run.** Steps 1
and 2 prove the file is well-formed; only step 3 proves it is restorable.

## 6. Security advisory posture

Supabase's performance advisor reports only `INFO`-level items: 53 unindexed
foreign keys (all attribution columns such as `*_created_by`, never used as
query predicates, and the schema uses `on delete restrict` so they are not
cascade-critical) and 47 unused indexes. None is a blocker and none is
addressed by Phase 18 — see `docs/PERFORMANCE.md` §2.4 for why no index was
added.

## 7. Pre-migration control totals — the comparison baseline

Captured 2026-10-13 17:40 UTC. Re-run the identical query after Step 2; **every
figure in this section must be unchanged**, because Phase 18 alters policy
predicates and two view definitions and touches no data.

### 7.1 Row counts

| Table | Rows |
| --- | --- |
| `clients` | **28** — active 26, inactive 1, blacklisted 1 |
| `guarantors` | 16 |
| `loans` | **35** — active 17, cleared 9, pending_approval 3, draft 2, approved 2, cancelled 2 |
| `loan_periods` | 44 |
| `loan_installments` | 719 |
| `loan_payments` | **470** — posted 469, reversed 1 |
| `payment_allocations` | 522 |
| `loan_penalties` | 5 |
| `journal_entries` | **565** |
| `journal_lines` | **1603** |
| `ledger_accounts` | 27 |
| `expenses` | 58 |
| `other_income` | 0 |
| `account_transfers` | 11 |
| `account_reconciliations` | 5 |
| `profiles` | 4 |
| `audit_log` | 1599 |
| `notifications` | 119 |

### 7.2 Accounting control totals (UGX, minor units as stored)

| Control | Value |
| --- | --- |
| Journal total debit | **88,499,530** |
| Journal total credit | **88,499,530** |
| **Journal balanced** | **true** |
| Trial balance debit | **88,499,530** |
| Trial balance credit | **88,499,530** |
| **Trial balance balanced** | **true** |
| Principal disbursed | 26,500,000 |
| Total interest contracted | 6,082,500 |
| Total expected repayment | 32,582,500 |
| Scheduled total (installments) | 32,582,500 |
| Payments posted | 22,286,867 |
| Payments reversed | 130,000 |
| Allocations total | 22,416,867 |
| — principal | 17,861,307 |
| — interest | 4,514,123 |
| — penalty | 41,437 |
| Penalties assessed | 860,589 |
| Contractual outstanding | 10,337,070 |
| Total outstanding | 11,156,222 |
| Delinquency states | cleared 9, in_arrears 9, penalty_due 5, expired_unpaid 2, due_today 1 |

Three invariants hold, which is what makes these usable as a baseline:

- `scheduled_total` = `total_expected_repayment` = 32,582,500
- allocation components sum exactly: 17,861,307 + 4,514,123 + 41,437 = 22,416,867
- `allocations_total − payments_posted` = 130,000 = the one reversed payment.
  The allocation rows of a reversal stay and stop counting as coverage, which
  is the documented Phase 6 behaviour.

### 7.3 Schema fingerprints

| | |
| --- | --- |
| Tables / views / functions | 49 / 34 / 145 |
| Policies / indexes / triggers / constraints | 88 / 200 / 140 / 579 |
| RLS-enabled tables | 49 of 49 |
| `fingerprint_policies` | `eda53ca479f2a3cfcb9b400cee0be55c` |
| `fingerprint_views` | `7c1112322141bf8c425d7a6af86f1e4b` |
| `fingerprint_functions` | `67d0269bf3d1b6a706f37fa924900995` |
| `fingerprint_columns` | `7bd18f98ca3982541ecb91cd2fa956cb` |
| Last migration | `20261016000200` |

After Step 2, expected changes: `fingerprint_policies` changes (81 predicates
rewritten), `fingerprint_views` changes (2 views replaced), `fingerprint_functions`
changes and the count rises 145 → 148 (`settings_reference_sequences`,
`current_user_branch_id`, `current_session_context` added;
`user_has_permission` and `user_can_see_branch` re-bodied). **`fingerprint_columns`
must NOT change** — no table or view column is altered. Policy count stays 88,
table count stays 49.

## 8. Step 2 — migration procedure

Apply in version order, **one migration per step, verifying between each**.

| # | Migration | What it does | Risk |
| --- | --- | --- | --- |
| 1 | `20261017000100_settings_reference_sequences` | Adds one `SECURITY DEFINER` function + grants | Very low — new object only |
| 2 | `20261018000100_rls_predicate_hoisting` | Adds `current_user_branch_id()`, re-bodies 2 helpers, rewrites 81 policy predicates | **Highest.** Touches every authorization predicate |
| 3 | `20261018000200_delinquency_pushdown` | `create or replace view loan_delinquency` | Low — same column contract |
| 4 | `20261018000300_session_context` | Adds `current_session_context()` + grants | Very low — new object only |
| 5 | `20261018000400_installment_coverage_pushdown` | `create or replace view loan_installment_coverage` | Low — same column contract |

Each file is idempotent in shape (`create or replace`, `alter policy`), so a
re-run is safe. None takes a table lock on a data table; the view replacements
take a brief `ACCESS EXCLUSIVE` lock on the view itself, which at 22 MB and
with no long transactions is sub-second.

**After migration 2, before continuing**, re-prove authorization:

```sql
-- Must be 88, and must still be 88 after.
select count(*) from pg_policies where schemaname = 'public';

-- Every policy still names a capability or the caller's own profile.
select tablename, policyname from pg_policies
 where schemaname='public'
   and coalesce(qual,'') || coalesce(with_check,'') not like '%user_has_permission%'
   and coalesce(qual,'') || coalesce(with_check,'') not like '%current_profile_id%'
   and tablename not in ('roles','permissions','role_permissions',
                         'repayment_frequencies','guarantor_consent_terms',
                         'loan_periods','payment_allocations');
-- Expect zero rows.

-- No predicate became unconditionally true.
select tablename, policyname from pg_policies
 where schemaname='public' and (qual = 'true' or with_check = 'true');
-- Expect zero rows.
```

Then re-run the §7.2 control totals and confirm every figure is unchanged, and
re-check `fingerprint_columns` is `7bd18f98ca3982541ecb91cd2fa956cb`.

Finally, with the database migrated and verified, the application deploy is a
**separate** decision: merge to the production branch and let Vercel build.
Note that `vercel.json` in this branch pins the region to `dub1`; that takes
effect on that deployment and is reversible by changing the file.

Order matters: the migrations are backward compatible with the currently
deployed build (they only add objects and make existing predicates cheaper),
so the database can go first and sit safely ahead of the application. The
reverse is not true — `current_session_context()` must exist before the new
build runs, or every authenticated page fails.

## 9. Rollback and recovery

Three tiers, cheapest first.

### Tier 1 — revert the migrations in place (minutes, no data loss)

Phase 18 changes only policy predicates and two view bodies. All four are
reversible by re-applying the previous definitions, which are in git:

```bash
git show 557d898:supabase/migrations/20261007000600_delinquency_views.sql   # loan_delinquency
git show 557d898:supabase/migrations/20261006000400_balance_views.sql       # loan_installment_coverage
```

- **Views** — re-run the pre-Phase-18 `create or replace view` for
  `loan_delinquency` (from `20261007000600`) and `loan_installment_coverage`
  (from `20261006000400`). Column contracts are unchanged, so dependents are
  unaffected.
- **Policies** — re-apply the original predicates. The exact pre-change set is
  fingerprinted as `eda53ca479f2a3cfcb9b400cee0be55c`; re-applying
  `20261002000300`, `20261003000500`, `20261004000600`, `20261005000500`,
  `20261006000700`, `20261007000900` and the later RLS files restores them, and
  the fingerprint confirms success.
- **New functions** — `drop function if exists public.current_user_branch_id()`,
  `public.current_session_context()`. Drop `current_session_context` **only
  after** the application is rolled back off the new build, or the new build
  loses its authentication path.
- `user_has_permission` and `user_can_see_branch` — re-apply from
  `20261002000100` and the branch-helper migration.

Then delete the five rows from `supabase_migrations.schema_migrations` so the
history matches the schema.

**This tier is sufficient for any failure Phase 18 can plausibly cause**,
because it changes no data.

### Tier 2 — point-in-time recovery (platform, minutes to hours)

If something unexpected has written data, use Supabase PITR from the project's
Database → Backups page and recover to just before the migration window.
Confirm the PITR window covers it **before** Step 2 — see §5.1. PITR restores
the whole project; coordinate it as an outage.

### Tier 3 — restore the §5.2 dump (hours)

The last resort, and the reason §5 is a blocker:

```bash
pg_restore --dbname="<target>" --no-owner --no-privileges --jobs=4 "${OUT}"
psql -d "<target>" -c 'analyze'
```

Then verify against §7.2. This loses anything written after the dump, so
record the dump time and reconcile writes since from `audit_log`.

### Application rollback

Independent of the database, and faster: redeploy the previous Vercel
deployment, or revert the merge commit. The database can stay migrated — the
old build does not call Phase 18's functions, and the hoisted policies and
rebuilt views are transparent to it.

---

## 10. Verdict

**NOT safe to proceed to Step 2 yet.** One blocker, and it is the backup.

Everything that can be verified from here is verified and green: the target is
confirmed, the database is healthy, the pending set is exactly the five
expected migrations, the drift is nine duplicate history rows with no schema
consequence, all 81 policy targets exist, and production's policy, view,
column and function definitions are **byte-identical** to the baseline the
migrations were generated against.

What is missing is a verified, restorable backup, which I cannot produce from
this environment and will not fake. Clear §5 and Step 2 is ready to run.
