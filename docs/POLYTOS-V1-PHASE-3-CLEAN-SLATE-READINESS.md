# POLYTOS V1 — PHASE 3 CLEAN-SLATE READINESS REPORT

**Date:** 2026-11-13
**Project:** `fszgwemtgyrbhngajpzm` ("lending manager"), eu-west-1, PostgreSQL
17.11.0.003, `ACTIVE_HEALTHY`, created 2026-10-06. Supabase Free.
**Branch under review:** `claude/polytos-v1-final-integration-vtuml7`
**Nothing hosted was changed.** Every hosted statement in this phase was a
`SELECT`. No migration was applied, no row deleted, no Auth identity or
Storage object touched, no deployment made, no project created.

Throughout, **Verified** means I observed it in this session and the evidence
is cited. **Assumption** means I did not observe it. Where a deletion decision
was uncertain, the answer is "do not delete".

---

## 1. Repository and PR verification

**Verified — all three pull requests exist, are draft and open, and their head
commits match the expected SHAs exactly.**

| PR | Purpose | Head branch | Head SHA | Expected | State |
| --- | --- | --- | --- | --- | --- |
| #28 | Security improvements | `claude/polytos-v1-security-integration-vtuml7` | `4d20c1d7383f024f…` | `4d20c1d` | ✅ draft, open |
| #29 | Owner operation and reconciliation safety | `claude/polytos-v1-owner-operation-vtuml7` | `6e77efaabaa7dbc4…` | `6e77efa` | ✅ draft, open |
| #30 | Launch documentation | `claude/polytos-v1-launch-readiness-docs-vtuml7` | `2d4df0611d5e0654…` | `2d4df06` | ✅ draft, open |

All three target `claude/intelligent-knuth-2r8mpw` at base `64ea09c`.

**Verified — the integration branch is exactly those three and nothing else.**
Tip `5d304338227542a3f3b49d824ffb2da59a71e9cd` (`5d30433`). `git merge-base
--is-ancestor` confirms each of `4d20c1d`, `6e77efa` and `2d4df06` is
contained. The history is the three merge commits over `64ea09c`, with no
additional work.

**Verified — the rehearsal results are current.** CI run
[43285549603](https://github.com/JTREVORM/lending-manager/actions/runs/43285549603)
ran against head SHA `5d304338227542a3f3b49d824ffb2da59a71e9cd`, which *is*
the branch tip today. The branch has not moved since the run, so the figures
are not stale. All four jobs concluded `success`, every step included:

- `database (real PostgreSQL)`
- `checks, unit/integration, build`
- `security release rehearsal (PostgreSQL 17, real Auth)`
- `browser E2E (production build, fresh seed)`

**Verified independently — I re-ran the suites locally rather than trusting
CI**, on a throwaway PostgreSQL 16 cluster with all 172 migrations replayed:

| Suite | Claimed | Measured locally | |
| --- | --- | --- | --- |
| Migrations replayed | 172 | **172** | ✅ |
| Database tests | 1,883 | **1,883 passed** (83 files) | ✅ |
| Database seeder tests | 82 | **82 passed** (18 + 15 + 24 + 25) | ✅ |
| Clean-slate tests | 25 | **25 passed** | ✅ |
| Unit and integration | 2,651 | **2,645 passed, 6 skipped** (2,651 total) | ⚠️ see below |
| Browser tests | 910 + 48 skips | not re-run locally; green in CI | ⚠️ CI only |

**One correction to the Phase 2 accounting.** The "5,551 passing tests" figure
adds the unit project's *total* (2,651) to the other suites' *passed* counts.
The 6 unit skips are counted as passing. Measured precisely across all six
suites: **5,545 passed, 54 skipped (6 unit + 48 browser), 5,599 total, zero
failures.** This is an arithmetic correction, not a defect — nothing is
failing, and the 48 browser skips were already declared expected.

**Not done, as instructed:** nothing was merged and nothing was deployed.

---

## 2. Hosted demonstration-data inventory

**Verified — migration state.** The hosted database has **161** of the
branch's **172** migrations applied (`supabase_migrations.schema_migrations`,
latest `20261103000100`). **11 are pending:**

```
20261104000100  remove_unintended_gate_probe
20261104000200  guard_ledger_account_balance_by_role
20261106000100  guard_loan_validation_disclosure
20261106000200  guard_consent_code_redemption
20261106000300  record_company_identity_exemption
20261106000400  retire_unused_definer_grants
20261106000500  guard_savings_amount_disclosure
20261106000600  restore_governing_policy_grant
20261106000700  guard_client_live_loan_disclosure
20261106000800  guard_bulk_meeting_fine_assessment
20261112000100  reconciliation_needs_a_second_person
```

**Verified — none of the 11 creates a table, and none touches
`reference_formats`.** This matters: both of the cleanup's refusal guards
compare the database against fixed lists, so a schema change between now and
the run would stop the procedure. It will not. (An earlier document saying the
branch and production "differ by exactly one migration" described an older
branch state and is now out of date.)

**Verified — row counts, read from the hosted project.** The headline figures
match the Product Owner's description exactly: **35 loans, 470 repayments.**

| Domain | Table | Rows | Class |
| --- | --- | --- | --- |
| Customers | `clients` | 28 | A |
| | `client_identities` | 28 | A |
| | `client_guarantors` | 34 | A |
| | `client_remarks` | 15 | A |
| | `guarantors` | 16 | A |
| | `guarantor_identities` | 16 | A |
| Lending | `loans` | **35** | A |
| | `loan_schedules` | 26 | A |
| | `loan_installments` | 719 | A |
| | `loan_guarantors` | 43 | A |
| | `loan_penalties` | 5 | A |
| Repayments | `loan_payments` | **470** | A |
| | `payment_allocations` | 522 | A |
| The books | `journal_entries` | 597 | A |
| | `journal_lines` | 1,667 | A |
| | debits / credits | 89,649,530 / 89,649,530 (balanced) | A |
| | `expenses` | 58 | A |
| | `other_income` | 0 | A |
| | `account_transfers` | 11 | A |
| | `account_reconciliations` | 5 | A |
| Membership | `memberships` | 6 | A |
| | `membership_fee_receipts` | 6 | A |
| | `membership_terms_acceptances` | 5 | A |
| | `savings_accounts` | 5 | A |
| | `savings_transactions` | 26 | A |
| Operational | `notifications` | 119 | A |
| Identity | `profiles` | 6 (6 active) | B / C — see §3 |
| | `user_roles` | 6 | B / A |
| | `auth.users` | 4 | C / A |
| History | `audit_log` | **1,673** (ids 1–1,682) | **C** |
| Policy | `membership_policy_versions` | 3 (1 active) | **C** |
| Storage | `storage.buckets` | 6, all private | B |
| | `storage.objects` | **0** | — |
| Reference | `roles` / `permissions` / `role_permissions` | 4 / 106 / 236 | B |
| | `ledger_accounts` | 35 | B |
| | `repayment_frequencies` | 5 | B |
| | `reference_formats` | 22 | B |
| | `loan_products` | 6 | B |
| | `guarantor_consent_terms` | 1 | B |
| | `benefit_document_kinds` | 13 | B |
| | `branches` | 1 | B |
| | `company_settings` / `business_settings` / `finance_settings` | 1 / 1 / 1 | B |
| | `reference_sequences` | 13 rows | B (values reset) |

**Verified — Storage is already empty.** 6 buckets, all `public=false`, **0
objects**, and `loan_documents`, `benefit_claim_documents` and
`membership_consent_challenges` are all 0. Storage handling at cutover is a
confirmed no-op: there is nothing to delete and the buckets are preserved.

**Verified — the six profiles.**

| Profile | Role | Auth user | Audit rows | Handling |
| --- | --- | --- | --- | --- |
| **Mwesigwa Trevor** `83944cea-…644f6` | `owner_admin` | yes | 82 | **PRESERVE — the Owner** |
| Ssemakula Brian Kato | `manager` | yes | 311 | deactivate, unlink, delete Auth user |
| Nakato Winnie Birungi | `secretary_treasurer` | yes | 1,084 | deactivate, unlink, delete Auth user |
| AKELLO MARY | `secretary_treasurer` | yes | 23 | deactivate, unlink, delete Auth user |
| DEMO Branch Witness | `secretary_treasurer` | **no** | 0 | deactivate (cannot sign in already) |
| DEMO Branch Manager | `manager` | **no** | 0 | deactivate (cannot sign in already) |

`auth.users` = 4 and exactly four profiles carry an `auth_user_id`, so there is
no orphan Auth identity. 1,500 of the 1,673 audit rows name one of these
profiles; **173 carry a NULL actor** (migration- and system-written entries).

---

## 3. Classification of protected and removable records

**A — Demonstration business data, eligible for clearing: 61 tables.** The
whole lending, customer, ledger, membership, savings, benefit, meeting and
operational-trace surface, as listed in §2. Verified count: the procedure's
`TRUNCATE_TABLES` holds exactly 61 entries.

**B — Essential configuration, preserved: 17 tables + the Owner's rows.** The
permission matrix (`roles`, `permissions`, `role_permissions`), the product and
reference catalogue, `branches`, the 35-account chart of accounts, the three
settings singletons, and `reference_sequences` (rows kept, values reset).
`user_roles` is preserved selectively: only the Owner's assignment survives.

**C — Protected historical data, cannot be removed:**

1. **`audit_log` — 1,673 entries.** Statement-level `BEFORE DELETE`,
   `BEFORE UPDATE` and `BEFORE TRUNCATE` triggers all call `reject_mutation()`
   and raise. **Verified on the hosted project** by reading `pg_trigger`.
2. **The five demonstration profiles.** `audit_log.actor_profile_id`
   references `profiles` `ON DELETE RESTRICT`, and the audit log cannot be
   emptied, so three of them are undeletable by design. (The two `DEMO`
   profiles have 0 audit rows and could in principle be deleted once the
   business tables are empty — but the procedure neutralises all five
   uniformly, which is the fail-closed choice and loses nothing.)
3. **The three `membership_policy_versions` rows.** `DELETE` is rejected
   outright at statement level, because a savings account is frozen to the
   version it was opened under.

**D — Unknown or potentially sensitive: none outstanding.** Every one of the
80 hosted tables and all 22 counter scopes classify into exactly one bucket —
**verified programmatically** by running the procedure's own `classify()` and
`classifySequences()` against the real hosted table and scope lists. Both
report `unclassified: []` and `missing: []`, so neither guard would refuse.

---

## 4. Clean-slate tooling review

The tooling is `scripts/clean-slate.mjs` (runner), `scripts/lib/clean-slate.mjs`
(library) and `tests/db/clean-slate.test.ts`. **It exists only on PR #28 and
the integration branch** — not on the base commit, which is why a checkout of
`64ea09c` appears to have no clean-slate tool at all.

### The eight features Phase 2 claimed

| Claim | Verdict |
| --- | --- |
| Dry-run by default | **Verified.** `--execute` is required; without it the run reports and exits 0. |
| Classification guarding | **Verified.** Refuses on any unclassified *or* missing table. |
| Controlled clearing of 61 business tables | **Verified.** `TRUNCATE_TABLES.length === 61`. |
| No unrestricted `CASCADE` | **Verified.** One `TRUNCATE` of all 61 together; the word `CASCADE` does not appear. |
| Preservation of essential schema and configuration | **Verified.** No DDL anywhere; `TRUNCATE`/`DELETE`/`UPDATE` only. |
| Owner/Admin preservation | **Partly — one real defect, now fixed.** See D2. |
| Repeatable operation | **Verified.** Re-running on an emptied database is a no-op. |
| Resetting eligible numbering counters | **No — 3 of 21 were reset.** See D3. |

### The ten safety requirements

| # | Requirement | Before | After |
| --- | --- | --- | --- |
| 1 | Explicit destructive-operation confirmation | ✅ `POLYTOS_CLEAN_SLATE=yes-empty-this-database` + `--execute` | ✅ |
| 2 | **Confirms the exact target project and database identity** | ❌ **D1** — only a regex "does this look hosted" | ✅ `--expect-project` |
| 3 | Refuses unknown tables or unexpected dependencies | ✅ tables | ✅ tables **and** counters |
| 4 | Preserves the designated Owner/Admin identity | ❌ **D2** — could delete every Auth user | ✅ |
| 5 | Prevents partially applied cleanup | ✅ one transaction, rollback on error | ✅ |
| 6 | Protects functions, migrations, RLS, triggers, permissions | ✅ no DDL | ✅ |
| 7 | Preserves essential settings and reference records | ✅ | ✅ |
| 8 | No orphaned financial references | ✅ nulls the 3 settings actor columns, then asserts | ✅ |
| 9 | Accurate before-and-after verification | ⚠️ weakened by D2 and D3 | ✅ |
| 10 | Does not bypass audit immutability | ✅ works around it, never disables it | ✅ |

### The four defects found

**D1 — The procedure never confirmed *which* database it was emptying.**
Severity: high. The enable phrase authorises emptying "a database"; nothing
checked that `DATABASE_URL` pointed at `fszgwemtgyrbhngajpzm`. A pasted or
stale connection string naming a different Supabase project would have passed
every check, because the only other hosted requirement was that a file named
by `--i-have-a-dump` exists. This is requirement 2, and it was absent.

**D2 — An Owner with no Auth identity would have deleted every Auth user, and
the verification would have passed.** Severity: high. Step 5 was:

```sql
delete from auth.users u
 where u.id is distinct from (select p.auth_user_id from public.profiles p where p.id = $1)
```

If the Owner's `auth_user_id` is NULL that subquery is NULL, and
`id is distinct from NULL` is **true for every row**. Demonstrated on a
disposable database: the predicate matched **3 of 3** users. The verification
that followed asked for `auth_users > 1`, which **zero satisfies** — so the run
would have reported a clean slate on a database nobody could sign in to. The
existing test asserted `toBeLessThanOrEqual(1)` and had the same blind spot.

**D3 — Only 3 of 21 eligible numbering counters were reset.** Severity:
medium. `RESET_SEQUENCES` held `client`, `loan`, `payment`. The hosted
database has 13 counter rows and **22 scopes** in `reference_formats`; 21 of
those number a table that gets emptied. Left unreset, the client's first real
journal voucher would be **JV2600598** (hosted `journal` counter is at 597),
the first expense voucher EX2600059, the first savings account SA260006. The
old test only checked the same three scopes, so it could not see this.
`branch` must *not* reset — `branches` survives, so its codes are taken.

**D4 — A comment claimed the procedure retires the demonstration policy; it
does not.** Severity: low, but on the most safety-critical point in the file.
The `PRESERVE_WHOLE` comment pointed at a `RETIRE_POLICY_VERSIONS` export that
does not exist, while the code 20 lines below correctly says it only *reports*
the policy.

All four are fixed, each with the test that demonstrates it — see §8.

---

## 5. Local rehearsal results

**Disposable local cluster only.** PostgreSQL 16 at
`postgresql://lending@localhost:5433/lending_test`, built by
`scripts/pg-local.sh`, 172 migrations replayed from empty. The hosted project
was never a target.

*Fidelity caveat:* local is PostgreSQL 16, hosted is 17.11. CI additionally
runs a PostgreSQL 17 rehearsal job with real Auth, which is green on this SHA.

**Verified — every §6 check passes.** `vitest --project clean-slate`: **33
passed** (25 original + 8 added), after building a representative book — two
loans driven to disbursement, paid, with schedules, allocations and journals —
and then emptying it with the real procedure.

| Required check | Result |
| --- | --- |
| Eligible business tables empty | ✅ 61 tables |
| Demonstration loans and repayments removed | ✅ |
| Debits equal credits | ✅ both 0 |
| Remaining opening ledger balances correct | ✅ 35 accounts present, all zero |
| No orphan records remain | ✅ no preserved row points at a removed profile |
| Required configuration and reference data survive | ✅ roles, permissions, chart of accounts, cadences, products, settings |
| Exactly one intended Owner/Admin active | ✅ 1 active profile, holds `owner_admin` |
| Authentication still works | ✅ exactly 1 Auth user **and it is the Owner's** (newly asserted) |
| Client numbering restarts | ✅ next client reference ends `…1`; all 21 reset counters at 0; `branch` untouched |
| A second cleanup attempt is safe | ✅ idempotent no-op |
| Security policies remain functional | ✅ capability lookup answers; unauthorised session refused |
| The loan engine works after cleanup | ✅ full workflow below |

**Verified — the complete business workflow, on the emptied database, as the
one Owner.** Owner login → register client with identity → add guarantor and
the relationship → create loan → submit → approve → disburse → generate
schedule → partial repayment → receipt → final repayment → **loan closure** →
reports (balances and arrears agree with the loan). Plus the refusals that
matter: a duplicate repayment does not take the money twice, an invalid
repayment is rejected, and **an unauthorised session is refused everything it
should be** — borrowers cannot reach another customer's data.

**Verified — no regression.** `vitest --project db`: **1,883 passed** after my
changes, identical to before. `tsc --noEmit`, `eslint` and
`prettier --check` all clean on every file touched.

**Verified — the hardened runner behaves, exercised end to end.** The local
dry run reports "Would empty 61 business tables" and changes nothing. The
three new refusals all fire **before the connection pool is opened**:

- hosted-looking URL, `--execute`, no `--expect-project` → *"Refusing to empty
  a hosted database without confirming which one."*
- `--expect-project` disagreeing with the URL → *"This is the wrong database.
  Nothing was changed."*
- `--expect-project` given but the URL names no project → *"The target
  identity cannot be confirmed, so it is not assumed."*

---

## 6. Preservation of Owner/Admin and configuration

**The Owner is `83944cea-eba0-4cec-989b-e44528b644f6` (Mwesigwa Trevor)** —
the only `owner_admin`, active, with an Auth identity.

Preservation is checked three times: the procedure refuses to start unless the
profile exists, is `active`, holds `owner_admin` **and now has a non-NULL
`auth_user_id`**; it keeps exactly that profile's `user_roles` row and exactly
that Auth user; and afterwards it asserts the Owner is still active, still
holds `owner_admin`, is still linked, and that the one surviving Auth user is
the Owner's.

**Verified — how access is actually revoked.** `current_profile_id()` resolves
only `status = 'active'` profiles that are not `must_change_password`. So
deactivating a profile revokes every capability, every RLS policy and every
definer RPC **immediately**, even if the holder is carrying an unexpired JWT.
Deleting the Auth user removes the credential; the deactivation is what closes
the door. That is why neutralising, not deleting, is sufficient for the
profiles the audit log pins in place.

Configuration preserved whole: the permission matrix (4 roles, 106
permissions, 236 grants), 35 ledger accounts, 5 cadences, 22 reference
formats, 6 loan products, 1 branch, the consent terms, the 13 benefit document
kinds and all three settings singletons. `loan_product_branches` is empty on
hosted today; it is preserved, not required to be populated.

---

## 7. Remaining historical-data limitations

These are consequences of deliberate immutability guarantees. The procedure
works around all three rather than disabling any of them, and this is what
survives a cleanup:

**A. The audit log cannot be emptied — 1,673 entries remain.**

*How post-launch activity is distinguished from demonstration history.*
**Verified:** `audit_log.id` is a dense, monotonic `bigint` — the hosted log
holds 1,673 rows with ids 1–1,682, and in the local rehearsal 78 rows occupied
ids 1–78 with no gaps. So a single watermark separates the two eras cleanly.
Three independent markers, which is what makes this safe rather than a
convention:

1. **The id watermark.** Record `max(id)` immediately after cutover.
   Everything above it is post-launch. (Hosted today: 1,682.)
2. **The cleanup writes its own boundary.** The neutralisation step is itself
   audited — the rehearsal shows `user.role_revoked` ×3 and
   `user.status_changed` ×3 appended as the last entries before real trading
   begins. The final `user.status_changed` row written by the cleanup *is* the
   boundary, recorded inside the append-only log where it cannot be edited.
3. **The actor.** Every demonstration actor ends `inactive` with
   `auth_user_id` NULL. Post-launch entries carry the Owner's profile, or a
   future real staff profile.

A genuinely empty audit log is only achievable on a database that never held
the demonstration activity — i.e. a new project. That remains a Product Owner
decision and **I am not recommending it**: the existing project is fully
usable, as §3 and §5 show.

**B. Five demonstration staff profiles remain, deactivated and unlinked.**
Three are undeletable while the audit log names them. All five end
`status = 'inactive'` with `auth_user_id = NULL`, holding no role, and their
Auth users are deleted. What remains is a row carrying a name, which is what
the audit trail needs to say who did something. No credential exists for any
of them.

**C. Three policy versions remain; `DELETE` is impossible.** 999.0
(DEMONSTRATION ONLY) plus 1.0 and 2.0, both still `draft`.

**This is the one finding that is a live launch risk, and it has a clean
answer.** Policy **999.0 is the only `active` policy**, it is approved, and
5 savings accounts are frozen to it. After the cleanup those accounts are
gone, but 999.0 would still be the version in force — so a real member could
be enrolled on demonstration terms.

**Verified — the schema already provides a sanctioned way to retire it, and no
fix is needed.** `membership_policy_versions_guard` enforces a one-way status
sequence `draft → active → superseded`, and `status` is **not** among the
contractual columns it freezes on approval. So:

```sql
update public.membership_policy_versions
   set status = 'superseded'
 where version = '999.0' and status = 'active';
```

is permitted, keeps the row and its promises readable, and needs no trigger
disabled, no constraint dropped and no row deleted. Afterwards
`active_membership_policy_id()` returns NULL, so
`membership_policy_allows(...)` answers `false` for every activity and
enrolment **fails shut** — the safe direction. This is proven by a new test,
not asserted.

**It is deliberately not part of the cleanup.** Retiring an approved business
instrument is an explicitly authorised act, not a side effect of emptying the
books. The procedure reports the policy; the runbook retires it as a separate,
named step.

---

## 8. Necessary minimal technical corrections

Committed as `9d509d9` on `ccr-84745867-cu3p1f`, pushed. Base
`5d30433` + one commit, fast-forward only. **Not merged anywhere, no PR
opened.** 5 files, +553/−20.

| Fix | Change | Test proving it |
| --- | --- | --- |
| **D1** | `--expect-project <ref>` required for a hosted `--execute`, compared against the project reference parsed from the connection string (both the `db.<ref>.supabase.co` and `postgres.<ref>` pooler forms). Mismatch, or an unreadable reference, refuses before the pool opens. | reads the ref from both URL forms; returns null for local, which is what makes an unconfirmable hosted target a refusal |
| **D2** | Pre-flight refuses an Owner with a NULL `auth_user_id`; verification now asserts `auth_users === 1` **and** that the survivor is the Owner's | refusal proven through a stub connection, so the test writes nothing to the append-only audit log |
| **D3** | `RESET_SEQUENCES` 3 → **21**; `PRESERVE_SEQUENCES = ['branch']`; new `classifySequences()` refuses an unclassified scope exactly as the table guard does, reading `reference_formats` (migration-managed) rather than `reference_sequences` (rows created on demand per scope per year) | every reset scope maps to a table in `TRUNCATE_TABLES`; all reset counters are 0 and `branch` is not; an unknown scope refuses |
| **D4** | Comment corrected to state what the code does and why | — |
| **Doc** | `POLYTOS-V1-LAUNCH-CONFIGURATION.md` item **A-1 rewritten** | see below |

**A fifth finding, in the Phase 2 launch documentation.** Item A-1 instructed
the operator to set policy 999.0 to `draft` and write
`is_enrolment_enabled`/`is_savings_enabled` to `false`. **Neither statement can
run, and both are now proven to fail:**

- `active → draft` is not in the guard's one-way sequence — it raises *"A
  membership policy version cannot move from active to draft."*
- `is_enrolment_enabled` and `is_savings_enabled` are **`GENERATED ALWAYS`**
  columns, derived from the policy's own figures precisely so no write can
  forge readiness. PostgreSQL refuses: *"column "is_enrolment_enabled" can
  only be updated to DEFAULT."*

Had this been executed at cutover it would have failed at the keyboard. A-1
now carries the single `status = 'superseded'` statement that works, with both
impossible steps documented as refused and covered by the test.

**No other change was made.** No new features, no schema migration, no change
to the hosted project.

---

## 9. Exact hosted cleanup execution plan

**Do not run any of this without explicit Product Owner authorisation.**
Steps 3, 6, 7, 8 and 9 are destructive or hosted-mutating.

### 1. Required repository and migration state

- Check out the integration branch at `5d30433` **plus** fix commit `9d509d9`
  (i.e. `ccr-84745867-cu3p1f`). The clean-slate tool does not exist on
  `64ea09c`, and `5d30433` alone carries defects D1–D3.
- Confirm CI is green on that commit before starting.
- Confirm the hosted project is `fszgwemtgyrbhngajpzm` and note that **11
  migrations are pending**.

### 2. Optional free precaution — a logical export

No paid backup is required. On the free plan a logical dump costs nothing and
is the only route back:

```sh
pg_dump "$DATABASE_URL" -Fc -f polytos-preclean-$(date -u +%Y%m%dT%H%M%SZ).dump
sha256sum polytos-preclean-*.dump
```

The runner **requires** `--i-have-a-dump <path>` for a hosted run, so in
practice this step is mandatory in the tool even though no paid service is.

### 3. Prevent access during the window

**There is no maintenance mode in the application** — verified, no
`MAINTENANCE` flag exists in `app/`, `lib/`, `config/`, `middleware` or
`proxy.ts`. What is available, all free:

- The business has **one Owner and no staff**, so coordination is the primary
  control: agree a window and have the Owner sign out.
- **The transaction is the real guarantee.** The whole cleanup runs in one
  transaction and `TRUNCATE` takes `ACCESS EXCLUSIVE` locks, so no concurrent
  request can interleave with it — a competing write blocks or fails, and any
  failure rolls the whole thing back.
- Optionally, reassign the Vercel production alias to a holding deployment for
  the window (free on any plan) and restore it afterwards.

Do **not** attempt to lock out access by setting the Owner's profile inactive
or `must_change_password` — the procedure refuses a non-active Owner, by
design.

### 4. Order of operations

1. Apply the **11 pending migrations** first (`supabase db push`), so the
   security guards from PRs #28/#29 are in force before any real client data
   exists. Verify `schema_migrations` reaches `20261112000100` and the count
   is 172.
2. Re-run the dry run (step 5) *after* migrating — the table and counter lists
   are checked against the live schema.
3. Then the cleanup (step 6).
4. Then retire policy 999.0 (step 7).

### 5. Dry run — expected to change nothing

```sh
export DATABASE_URL='<hosted connection string>'
node scripts/clean-slate.mjs --owner 83944cea-eba0-4cec-989b-e44528b644f6
```

Expect `hosted connection: yes`, `owner kept: Mwesigwa Trevor (owner_admin)`,
"Would empty 61 business tables", and the before-figures in §2. **Stop if the
table or counter guard refuses** — that means the schema moved and the lists
need a decision, which is exactly what it is for.

### 6. The cleanup

```sh
POLYTOS_CLEAN_SLATE=yes-empty-this-database \
node scripts/clean-slate.mjs \
  --owner 83944cea-eba0-4cec-989b-e44528b644f6 \
  --expect-project fszgwemtgyrbhngajpzm \
  --i-have-a-dump ./polytos-preclean-<stamp>.dump \
  --execute
```

Auth and Storage are handled inside that same transaction: the three non-Owner
Auth users are deleted, and `storage.objects` is cleared — **already empty on
hosted, so a verified no-op**; the 6 private buckets are untouched.

### 7. Retire the demonstration policy (separate authorisation)

Launch item A-1, the corrected statement in §7C. Then confirm no policy is
`active`.

### 8. Post-cleanup verification queries

```sql
-- the books are empty and balanced
select (select count(*) from public.clients)                       as clients,
       (select count(*) from public.loans)                         as loans,
       (select count(*) from public.loan_payments)                 as payments,
       (select count(*) from public.journal_entries)               as journal_entries,
       (select coalesce(sum(debit),0)  from public.journal_lines)  as debits,
       (select coalesce(sum(credit),0) from public.journal_lines)  as credits,
       (select count(*) from public.memberships)                   as memberships,
       (select count(*) from public.savings_accounts)              as savings;
-- expect: 0 everywhere, debits = credits = 0

-- exactly one person can work, and it is the Owner
select (select count(*) from public.profiles where status='active') as active_profiles,
       (select count(*) from auth.users)                            as auth_users,
       (select count(*) from public.user_roles)                      as role_grants;
-- expect: 1, 1, 1

-- every ledger account survives at zero
select count(*) as accounts, count(*) filter (where bal <> 0) as nonzero from (
  select a.id, coalesce(sum(l.debit),0) - coalesce(sum(l.credit),0) as bal
    from public.ledger_accounts a
    left join public.journal_lines l on l.account_id = a.id
   group by a.id) t;
-- expect: 35, 0

-- numbering restarts; branch does not
select scope, last_value from public.reference_sequences order by scope;
-- expect: branch = 1, every other scope = 0

-- the audit watermark, to record in the launch log
select count(*) as entries, max(id) as watermark, max(occurred_at) as last_entry
  from public.audit_log;
-- expect: ~1,683+ entries; RECORD the watermark

-- configuration intact
select (select count(*) from public.roles)             as roles,            -- 4
       (select count(*) from public.permissions)        as permissions,      -- 106
       (select count(*) from public.ledger_accounts)    as ledger_accounts,  -- 35
       (select count(*) from public.loan_products)      as loan_products,    -- 6
       (select count(*) from public.repayment_frequencies) as cadences;      -- 5

-- no policy governs anything
select version, status from public.membership_policy_versions order by version;
-- expect: 1.0 draft, 2.0 draft, 999.0 superseded
```

### 9. Financial zero-balance verification

Debits and credits both 0, all 35 ledger accounts at zero, no orphaned
`updated_by` on the three settings tables (the runner asserts this itself and
exits non-zero on any failure).

### 10. Validate the first real client and loan

As the Owner, on the hosted app: register the first client (confirm the
reference is **CL26001**, not CL26029), add a guarantor, create → approve →
disburse a loan (confirm **LN260001**), generate the schedule, take a partial
repayment (confirm receipt **PAY260001**), then settle and confirm closure, and
check the reports agree. This is the same path rehearsed locally in §5.

### 11. Stop conditions and failure handling

**Stop and change nothing further if:**

- the table or counter guard refuses — a migration moved the schema;
- `--expect-project` refuses — the connection string is wrong;
- the Owner pre-flight refuses — the designated profile is not active, lacks
  `owner_admin`, or has no Auth identity;
- the post-run verification prints `VERIFICATION FAILED` (the runner exits 1);
- the first real client is not numbered `…001`.

A failure inside the transaction rolls back the whole cleanup: the database is
left exactly as it was, so the correct response is to diagnose and re-run, not
to patch forward. Recovery from a *completed* run is only from the dump.

### 12. Irreversible consequences

Once step 6 commits, **the following are permanently gone** and recoverable
only from the logical dump: 28 clients and their identities, 16 guarantors,
35 loans with 26 schedules and 719 installments, 470 repayments and 522
allocations, 597 journal entries and 1,667 journal lines (UGX 89,649,530 on
each side), 58 expenses, 11 transfers, 5 reconciliations, 6 memberships, 5
savings accounts and 26 savings transactions, 119 notifications, and the Auth
credentials of three staff accounts.

**What survives and cannot be erased:** 1,673 audit entries and the five
deactivated profiles they name, and three policy version rows. A clean slate
is not the same as a database with no history, and this report does not claim
it is.

---

## 10. Outstanding Product Owner decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | **Authorise the hosted cleanup at all.** Everything in §9 is prepared and rehearsed; none of it has run. | Proceed when ready — the procedure is verified and fails closed. |
| 2 | **Retire policy 999.0?** It is the only active policy and would govern a real member's enrolment. | **Yes — this is the one genuine launch blocker.** The corrected one-line statement in §7C is schema-sanctioned and proven. |
| 3 | **Approve policy 1.0 or 2.0 before selling membership?** Both are still `draft`, so after retiring 999.0 no policy is in force and enrolment fails shut. | Fine for V1, which sells neither membership nor savings. Decide before the first member. |
| 4 | **Confirm the three login-capable staff accounts should go.** Brian, Winnie and Mary can sign in today against real financial records. | Delete the Auth users (the cleanup does this). You stated no staff are employed. |
| 5 | **Accept the residual audit history**, or start a fresh project for a genuinely empty log. | **Accept it.** The existing project is fully usable; §7A gives three independent ways to tell the eras apart. I found no technical impossibility requiring a new project. |
| 6 | **When to apply the 11 pending migrations.** | Before the cleanup, per §9.4 — they are security guards and should be in force before real client data exists. |
| 7 | **Whether to take the Vercel alias down for the window.** | Optional. The single transaction is the real protection; with one Owner, coordination suffices. |
| 8 | **Whether to merge PRs #28/#29/#30 and the fix commit.** | Out of this phase's scope — all remain draft and unmerged, as instructed. |

---

## Authorisation boundaries observed

Read repository code ✅ · hosted Supabase inspected **read-only** ✅ · local
cleanup tooling modified ✅ · regression tests added ✅ · disposable local
databases used ✅ · isolated development branch pushed ✅

Not merged to default or production ✅ · not deployed to Vercel ✅ · no hosted
migration applied ✅ · no hosted data deleted ✅ · hosted database not reset or
recreated ✅ · hosted Auth untouched ✅ · hosted business configuration
unchanged ✅ · no Storage object touched ✅ · no new Supabase project ✅ · no
paid service required ✅ · no audit or financial control bypassed ✅ · no
unrelated features ✅
