# POLYTOS — integrated release readiness audit

**Date:** 2026-11-09 · **Type:** read-only audit · **Scope:** the whole stacked
pull-request chain (#19 through #26), the hosted Supabase project, and the
Vercel project that serves it.

Nothing was deployed, merged, migrated, activated or deleted. Every hosted
query in this report is a `SELECT`, a metadata read or an advisor read. The
one piece of real work done here was local: the combined migration set of the
chain **plus** PR #19 was applied to a throwaway PostgreSQL database, because
until today no machine had ever held both at once (§2.4). Those throwaway
databases were dropped afterwards.

---

## 0. Verdict

**NO-GO for taking real customer money today.** Not because of the code — the
code is in better shape than the environment around it — but because of six
things, four of which are decisions and two of which are settings:

| # | Blocker | Kind | Who decides |
| --- | --- | --- | --- |
| **B1** | The Supabase organisation is on the **free tier**: no managed backups, no point-in-time recovery, and projects pause when idle. `docs/BACKUP-RESTORE.md` already names the tier a **launch condition**; it is not met | Setting (paid) | Product Owner |
| **B2** | The production URL is behind **Vercel SSO** and there is **no custom domain**, so a counter clerk in Uganda cannot reach the application at all | Setting | Product Owner / Operator |
| **B3** | **Lending cash sufficiency** — a disbursement, a benefit payment or a savings withdrawal may still take Cash at Hand negative. Policy unresolved (Decision A, §10.1) | Decision | Product Owner |
| **B4** | **Provider commercial terms** are unapproved, so no agency provider may be activated and the agency module, though complete, cannot legally post a single transaction (§10.3) | Decision | Product Owner |
| **B5** | The **active membership policy on the hosted project is version 999.0, "DEMONSTRATION ONLY"**. Policy 1.0 and 2.0 are both draft and unapproved (§5.6) | Decision | Product Owner |
| **B6** | **No branch is protected** on GitHub, so nothing stops a red pull request being merged, and the four mandatory CI jobs are advisory in practice (§5.4) | Setting | Product Owner |

**GO, with conditions, for the software itself.** The chain merges cleanly, the
combined 200-migration schema applies and passes its own security and upgrade
gates (§2.4), the ledger invariants are enforced in the database rather than in
TypeScript (§3), and the hosted books balance to the shilling today (§2.3).
What stands between the code and a release is §9's checklist, and most of it is
not code.

**Decision L** (approval thresholds) is open but is **not** a blocker: the
column is stored, read by nothing, and shown struck through. Leaving it open
ships a system with no amount ceiling, which is a risk to accept knowingly
rather than a defect (§10.2).

---

## 1. Pull-request dependency, merge order and conflict risk

### 1.1 The chain, as it actually is

The repository's default branch is **`claude/intelligent-knuth-2r8mpw`** at
**`64ea09c`**. There is no `main`. Every branch below is **0 commits behind**
that tip, so nothing needs rebasing before it merges.

| PR | Branch | Head SHA | Base | Ahead of `64ea09c` | Migrations on branch | State |
| --- | --- | --- | --- | --- | --- | --- |
| **#19** | `security/production-certification-2026-11-04` | `3d09f93` | default | 10 | 163 | open, **draft** |
| **#20** | `ccr-2f5e3786-jo3efn` | `4e6460f` | default | 10 | 169 | open, **draft** |
| **#21** | `phase3/financial-certification-2026-11-06` | `9b0d1ef` | #20 | 20 | 169 | open, **draft** |
| **#22** | `phase4a/agency-foundation-2026-11-07` | `643bb38` | #21 | 28 | 180 | open, **draft** |
| **#23** | `phase4b/agency-transaction-engine-2026-11-07` | `1d30d5d` | #22 | 37 | 186 | open, **draft** |
| **#24** | `phase4c/agency-settlement-reconciliation-2026-11-07` | `5eb0158` | #23 | 49 | 193 | open, **draft** |
| **#25** | `fix/shared-till-concurrency-2026-11-08` | `6da70d9` | #24 | 50 | 194 | open, **draft** |
| **#26** | `phase4d/agency-banking-interface-2026-11-08` | `38633d8` | #25 | 67 | 198 | open, **draft** |

PR #26's certified implementation commit is **`20e6fcd`** (CI run
**42613096813**, event `pull_request`, attempt **1**, conclusion **success**);
`38633d8` is the documentation-only commit that followed it and changed no
code.

### 1.2 The one thing most likely to be got wrong

**PR #19 is not part of the chain.** It is a *sibling* of #20 off the same
base. `git merge-base --is-ancestor` says plainly that #19 is **not** an
ancestor of #26. If #19 is treated as "an earlier one in the stack", it will be
assumed merged when it is not, and its two production security fixes — the
`__gate_probe` removal and the `ledger:view` guard — will quietly never reach
production. The hosted project still carries `__gate_probe` today (§5.5), which
is what that mistake looks like from the outside.

### 1.3 Merge order

```
64ea09c (default branch)
  ├── #19  security/production-certification   ← merge FIRST, independently
  └── #20 → #21 → #22 → #23 → #24 → #25 → #26 ← then the chain, in this order
```

1. **#19** first. It is the smallest, it is the only one that fixes something
   already live, and merging it first means the chain's own
   `tests/db/financial-authorization.test.ts` tightens by itself (§1.5).
2. Then **#20 → #21 → #22 → #23 → #24 → #25 → #26**, each into the one below
   it, or — simpler and equivalent — retarget **#20** at the default branch,
   merge it, then let each PR's base advance in turn. GitHub will retarget each
   child automatically as its parent merges.
3. Do **not** merge #26 directly into the default branch. It would carry #20
   through #25 with it in one commit and discard six review boundaries and six
   separate CI records.

### 1.4 Conflict risk: measured, not estimated

| Probe | Method | Result |
| --- | --- | --- |
| #20 → #21 → … → #26 | `git merge-base --is-ancestor` on each pair | **every step is a fast-forward** — no merge commit, so no conflict is possible |
| #19 into #26's head | `git merge-tree --write-tree` | **clean**, tree `aa83a2f`, exit 0 |
| File overlap, #19 vs the chain | path intersection | **zero**. #19 touches six files; the chain touches none of them |

PR #19's six files: `.github/workflows/production-anonymous-smoke.yml`,
`.gitignore`, `docs/POLYTOS-PRODUCTION-SECURITY-REVIEW-2026-11-04.md`, the two
`20261104*` migrations, and `tests/db/forced-password-authorization.test.ts`.

So the textual merge is safe in every direction. The risk in this release is
not textual — it is in §2.

### 1.5 One semantic interaction, checked

PR #19's `20261104000200` replaces `public.ledger_account_balance(uuid)` to
raise `42501` unless the caller holds `ledger:view`. Three questions had to be
answered before that can be called safe:

- **Does anything on the chain redefine the same function later, silently
  reverting the guard?** No. The last definition on the chain is
  `20261103000100`, which is *older* than `20261104000200`, so on a fresh build
  #19's version wins. Verified by scanning every migration dated after
  `20261104` for a redefinition: none.
- **Does the guard break the agency engine?** No, but only just. The guard
  fires whenever `auth.uid()` is non-null, and `SECURITY DEFINER` does not
  change `auth.uid()` — so a nested call from a definer function is still
  judged by the real caller's capabilities. `assert_cash_available()` and
  `assert_agency_float_available()` both call
  `ledger_account_balance()` internally, and they sit on the posting path of
  every agency transaction. The three roles that can reach those paths —
  `owner_admin`, `manager`, `secretary_treasurer` — all hold `ledger:view`
  (`20261010000100`), and no fourth role does. The borrower `client` role never
  reaches them. Confirmed empirically in §2.4 by running the engine suites
  against the merged schema.
- **Is the chain's own test aware of it?** Yes, and deliberately. The chain's
  `tests/db/financial-authorization.test.ts` reads the live function definition
  for the string `ledger:view` and asserts the *refusal* when the guard is
  present and the *current exposure* when it is not — so it states which schema
  it ran against instead of passing silently. Its comment names #19's migration
  by filename. One nit: the comment says "at 169 migrations … and at 171 it is
  not"; after the full chain those numbers are 198 and 200. The mechanism is
  sound; only the illustration is stale.

---

## 2. Migration ordering, and reconciliation with the hosted history

### 2.1 Which PR brings which migrations

| PR | New migrations | Range |
| --- | --- | --- |
| #19 | 2 | `20261104000100` – `20261104000200` |
| #20 | 8 | `20261106000100` – `20261106000800` |
| #21 | **0** | code, tests and certification only |
| #22 | 11 | `20261107000100` – `20261107001100` |
| #23 | 6 | `20261108000100` – `20261109000200` |
| #24 | 7 | `20261110000100` – `20261111000100` |
| #25 | 1 | `20261112000100` |
| #26 | 4 | `20261113000100` – `20261114000100` |
| | **39** | |

### 2.2 The full ordering to apply to production

39 files, in filename order, which is also dependency order. Note that #19's
two sort **between** `20261103000100` (already live) and #20's `20261106*`, so
a merge of #19 after the chain still leaves a correctly ordered set on a fresh
build, and on the hosted project every one of the 39 is newer than the highest
applied version.

```
 1  20261104000100_remove_unintended_gate_probe              #19
 2  20261104000200_guard_ledger_account_balance_by_role       #19
 3  20261106000100_guard_loan_validation_disclosure           #20
 4  20261106000200_guard_consent_code_redemption              #20
 5  20261106000300_record_company_identity_exemption          #20
 6  20261106000400_retire_unused_definer_grants               #20
 7  20261106000500_guard_savings_amount_disclosure            #20
 8  20261106000600_restore_governing_policy_grant             #20   ← must follow 6
 9  20261106000700_guard_client_live_loan_disclosure          #20
10  20261106000800_guard_bulk_meeting_fine_assessment         #20
11  20261107000100_agency_extend_financial_constraints        #22
12  20261107000200_agency_chart_of_accounts                   #22
13  20261107000300_agency_provider_registry                   #22
14  20261107000400_agency_transactions                        #22
15  20261107000500_agency_settlement_and_reconciliation       #22
16  20261107000600_agency_transaction_audit_log               #22
17  20261107000700_agency_permissions                         #22
18  20261107000800_agency_provider_catalogue_provisional      #22
19  20261107000900_branch_cash_position_agency_float          #22
20  20261107001000_agency_live_posting_readiness              #22
21  20261107001100_notify_low_agency_float                    #22
22  20261108000100_agency_commission_engine                   #23
23  20261108000200_agency_posting                             #23
24  20261108000300_agency_lifecycle                           #23
25  20261108000400_agency_reversal                            #23
26  20261109000100_ledger_balance_serialization               #23
27  20261109000200_agency_payable_and_commission_controls     #23
28  20261110000100_agency_settlement_locks_and_commission     #24
29  20261110000200_agency_payable_settlement                  #24
30  20261110000300_agency_float_replenishment                 #24
31  20261110000400_agency_reconciliation                      #24
32  20261110000500_agency_commission_correction               #24
33  20261110000600_agency_reporting_views                     #24
34  20261111000100_agency_concurrency_closure                 #24
35  20261112000100_shared_till_account_locking                #25
36  20261113000100_agency_commission_exception_amount         #26
37  20261113000200_agency_verification_revision               #26
38  20261113000300_agency_operational_registers               #26
39  20261114000100_agency_idempotency_replay_guard            #26
```

**Ordering constraints that are not just alphabetical:**

- **8 must follow 6.** `20261106000400` withdraws `authenticated` EXECUTE from
  seven uncalled functions; `20261106000600` puts one of them back, because two
  `SECURITY INVOKER` functions need it. Applying 8 without 6 is harmless;
  applying 6 without 8 leaves two reads broken.
- **12 before 13–21.** The agency chart of accounts must exist before the
  provider registry references `2210`, `2220` and the `4500` series by code.
- **26 before 28–34.** `ledger_balance_serialization` re-defines
  `assert_cash_available()` and `assert_agency_float_available()` to lock before
  they read; everything in #24 is written on that assumption.
- **35 before 36–39.** `shared_till_account_locking` moves cash-account locking
  into `post_journal()` itself. It is what makes every one of the 29 posting
  functions serialised rather than only the agency ones.
- **1 and 2 before anything else, or at least before 3.** Not technically
  required, but it is the whole point of merging #19 first: the two live
  defects close before thirty-seven new migrations are stacked on top of them.

### 2.3 Reconciliation with the hosted migration history

Read from the hosted project `fszgwemtgyrbhngajpzm` ("lending manager",
eu-west-1, PostgreSQL 17.11, `ACTIVE_HEALTHY`):

| | Count | Highest version |
| --- | --- | --- |
| Applied on the hosted project | **161** | `20261103000100_definer_rpc_business_identity` |
| Present in the repository (PR #26 head) | **198** | `20261114000100` |
| Present after #19 also merges | **200** | `20261114000100` |

- **Drift: none.** Every one of the 161 hosted versions exists in the
  repository under the same version number. Nothing has been applied to
  production that is not in git — which is the question this reconciliation
  exists to answer.
- **The hosted project is exactly the default branch.** 161 applied = 161 on
  `64ea09c`. Production's deployment is also `64ea09c` (§5.1). Database and
  application are in step.
- **Pending: 39** — the 37 from the chain plus #19's 2.
- The hosted financial baseline today: **debits 89,649,530 = credits
  89,649,530**, **0** unbalanced entries across 597 journal entries and 1,667
  lines, 35 ledger accounts, 1 branch, 28 clients, 35 loans, 470 payments,
  1,673 audit rows, 6 profiles holding `owner_admin`, `manager` and
  `secretary_treasurer`. Record these figures before the release and re-check
  them after; they must not move by a shilling, because no migration in the 39
  posts anything.
- The hosted chart of accounts has **no** agency accounts yet (`1310`,
  `1320.*`, `2210`, `2220`, `4510`–`4560` all arrive with migration 12). Any
  rehearsal that assumes a float till exists on production is testing something
  that is not there.

### 2.4 The combined set had never been built — so it was built

Both halves of this release have been tested exhaustively, and never together:
CI builds the chain, and #19 was certified on its own branch. That is the gap
this audit closed.

| Step | Result |
| --- | --- |
| `git merge-tree` of #26 and #19 | clean, tree `aa83a2f` |
| 200 migrations applied in order to a fresh PostgreSQL 16 database | **all 200 applied, no error** |
| `ledger_account_balance` carries the `ledger:view` guard afterwards | **yes** — not reverted by any later file |
| `public.__gate_probe` present afterwards | **no** — removed, as intended |
| Tables / RLS enabled | 90 / 90 |
| `SECURITY DEFINER` views | 1 (`company_identity`, the recorded exemption) |
| Definer functions without a pinned `search_path` | **0** |
| Journal balance constraint triggers | 2, both `DEFERRABLE INITIALLY DEFERRED` |
| `scripts/check-database-security.mjs` | **pass** — "No unreviewed privileged exposure" |
| `scripts/audit-financial-arithmetic.mjs` | **pass** — 246 files, no hazard, 6 acknowledged exemptions, positive control verified |
| `scripts/verify-membership-upgrade.mjs` | **pass** — 99 existing migrations, a seeded book, then 101 new ones; all 28 financial figures identical |

**One real defect found, and it is in the tooling rather than the schema.**
`scripts/verify-membership-upgrade.mjs` splits the migrations into "released
schema" and "unreleased phases" using a hand-kept list of date prefixes,
`PHASE_PREFIXES`. That list contains `20261103` and `20261106` but **not
`20261104`**. Run against the merged set, the verifier reported "99 existing
migrations … then 101 new migrations", and neither `20261104000100` nor
`20261104000200` appears anywhere in the 101 it listed — they were applied with
the *released* schema, before the seeded book. The run still passes, and the
practical loss is small because those two files move no money. But the
verifier's whole purpose is to measure each unreleased migration's effect on a
real book, and for these two it silently does not. The self-check added in
Phase 4D-F does not catch it, because that check only refuses prefixes *newer*
than the newest listed one, and `20261104` is older than `20261114`.

**Required before merging #19:** add `'20261104',` to `PHASE_PREFIXES` in
`scripts/verify-membership-upgrade.mjs`. One line, and it belongs on the chain
(PR #20 or later), because the chain's copy of the file is the one that
survives the merge. This audit did not make that change.

---

## 3. Financial invariants

Every figure below was read from the merged 200-migration schema, not from the
delivery reports.

### 3.1 The ledger itself

| Invariant | How it is enforced | Where |
| --- | --- | --- |
| Every journal entry balances | two **constraint triggers**, `journal_entries_assert_balanced` and `journal_lines_assert_balanced`, both `DEFERRABLE INITIALLY DEFERRED`, calling `journal_assert_balanced()` at commit | `20261010000300`, hardened since |
| A line is a debit **or** a credit, never both | `CHECK journal_lines_one_side` | `20261010000100` |
| No negative amounts | `CHECK journal_lines_debit_not_negative`, `..._credit_not_negative` | `20261010000100` |
| The journal is append-only | `reject_mutation()` triggers — **80** of them across the schema, including on `journal_entries` and `journal_lines` | throughout |
| One writer | `post_journal(...)` is the only function that inserts journal rows; **29** functions call it and none insert directly | `20261010000300` |
| An entry cannot reverse itself | `CHECK journal_entries_not_own_reversal` | `20261010000100` |
| Money is whole shillings | `bigint` minor units, basis points, half-up rounding `((P*bps)+5000)/10000`; `scripts/audit-financial-arithmetic.mjs` scans all 246 financial files for floating-point arithmetic and verifies itself against a positive control | ADR-002, ADR-003 |

Today's hosted books: **89,649,530 debits = 89,649,530 credits**, zero
unbalanced entries. The invariant is not theoretical.

### 3.2 Cash sufficiency — the precise shape of the open decision

This is the most consequential table in the audit, because it scopes Decision A
exactly. Of the 29 functions that post journals:

**Serialisation is universal.** `post_journal()` itself now locks every
cash-kind account in the entry before writing (`20261112000100`, PR #25),
sorted by account id so two callers cannot deadlock. So *all* 29 are protected
against two tills spending the same shilling concurrently.

**Sufficiency is not universal.** Nine functions assert it; the rest do not:

| Asserts cash availability | Does not |
| --- | --- |
| `post_agency_transaction` | `post_disbursement_journal` ← **loan disbursement** |
| `reverse_agency_transaction` | `post_savings_withdrawal` ← **savings withdrawal** |
| `post_agency_payable_settlement` | `post_benefit_payment` ← **benefit payment** |
| `reverse_commission_settlement` | `post_reversal_journal`, `reverse_savings_transaction`, `reverse_membership_fee`, `reverse_meeting_fine_payment`, `reverse_benefit_payment` ← **refunds, which also take cash out** |
| `post_float_replenishment` | `approve_reconciliation` |
| `post_transfer_journal`, `reverse_transfer` | and the money-**in** functions, where sufficiency does not apply: `post_repayment_journal`, `post_savings_deposit`, `record_membership_fee`, `record_other_income`, `post_meeting_fine_payment` |
| `post_expense_journal`, `reverse_other_income` | |
| `approve_agency_cash_reconciliation` | |

`assert_cash_available()` locks the account, reads
`finance_settings.allow_negative_cash` (default `false`), and refuses with
`P0001` naming the account and both figures. The three lending paths above
never call it. That is the gap — a policy gap, not a concurrency one, and it is
§10.1.

**Float sufficiency is separate and complete.**
`assert_agency_float_available()` reads only
`finance_settings.allow_negative_agency_float`, deliberately never
`allow_negative_cash`, so relaxing the cash rule can never relax the float
rule. It refuses any account that is not an agency float account.

### 3.3 Lock discipline

| Rule | Evidence |
| --- | --- |
| `lock_agency_provider_balance(provider, branch)` is taken **before** `lock_ledger_balances(uuid[])` | 8 functions take the provider lock, 17 take the ledger lock; the ordering is asserted by `tests/db/shared-till-concurrency.test.ts` and `agency-engine` |
| Ledger locks are sorted by account id | inside `lock_ledger_balances`, so lock order never depends on the caller |
| Account locks cover accounts moving in **either** direction | `20261112000100`; a till being credited is locked as well as one being debited |
| GL `1310` and the `2200` series are deliberately **not** account-locked | documented in `docs/POLYTOS-AGENCY-LOCK-RESOURCE-MATRIX.md`: they are serialised by the provider-balance lock instead, so a shared payable does not serialise every branch |

### 3.4 Provider attribution and the commission snapshot

| Invariant | Enforcement |
| --- | --- |
| A posted transaction carries the commission basis that was in force when it posted, not the current one | `CHECK agency_transactions_snapshot_iff_posted`, `..._snapshot_basis_agrees`, `..._snapshot_basis_valid`, `..._snapshot_model_valid`, `..._snapshot_computed_not_negative` |
| Commission income lands in the provider's own account | `agency_service_providers.income_account_id`, seeded per category: `4510` mobile money, `4520` bank agency, `4530` utilities, `4540` school fees, `4550` TV, `4560` airtime and data |
| A `cash_payable` provider must name a payable account; a `provider_float` provider must not | `CHECK agency_providers_payable_required_for_cash_payable`, `..._no_payable_for_provider_float` |
| A provider cannot be confirmed without stating what it pays | `CHECK agency_providers_confirmed_states_commission` — `NULL` means nobody decided; zero is stated as `commission_fixed = 0` |
| A commission exception is authorised, complete, reasoned and pinned | four CHECKs on `agency_transactions`: `..._commission_exception_authorised`, `..._complete`, `..._not_blank`, `..._pinned` |
| Nothing posts against a provisional or inactive provider | `agency_transaction_live_readiness_guard()` — five conditions, below |

The readiness gate refuses any transition out of `draft` unless: the provider
is confirmed (`is_provisional = false`), the provider is active, the transaction
type is active, the type states a `max_single_transaction` (no silent
"unlimited"), and the provider states a commission basis (no silent "zero").
This is why §10.3 is a release blocker for the agency module and not a
nice-to-have: the database will refuse every agency posting until the Product
Owner answers.

### 3.5 Commission and payable settlement

| Invariant | Enforcement |
| --- | --- |
| A settlement amount is positive | `CHECK agency_commission_settlement_amount_positive`, `agency_payable_settlement_amount_positive` |
| A statement or receipt reference has a shape, and is unique per provider, branch and reference | `CHECK ..._ref_shape` plus unique indexes; the browser suite proves the duplicate is refused and writes nothing |
| A reversed settlement is complete; an unreversed one is clean | `CHECK ..._reversed_is_complete`, `..._unreversed_is_clean` — the status, the reason, the reverser and the time move together or not at all |
| A payable settlement may not take the payable below zero | net-debit refusal in `post_agency_payable_settlement`, proven in the browser against the database |
| A reversal adds a contra entry and keeps the original | both entries survive; balances return to their prior figures exactly |
| A float replenishment posts exactly two balanced lines | proven end to end in `tests/e2e/specs/agency.write.spec.ts` |

### 3.6 Separation of duties, staleness and replay

| Invariant | Enforcement |
| --- | --- |
| The person who records a transaction may not verify it | `CHECK agency_transactions_verifier_not_submitter`, plus `agency_transactions_posted_has_verifier` |
| The person who counts cash or a float may not certify the count | `CHECK agency_cash_recon_maker_is_not_checker`, `agency_float_recon_maker_is_not_checker` |
| A variance write-off needs approval and, for a float, evidence | `CHECK ..._writeoff_needs_approval`, `agency_float_recon_writeoff_needs_evidence` |
| A Manager cannot verify figures they have not seen | `agency_transactions.revision`, incremented by a trigger on any financial change; `verify_agency_transaction(p_transaction_id, p_expected_revision)` refuses a stale revision after the idempotent early return, so retries still work |
| A reused idempotency key with different details is refused, not silently answered with the old transaction | `create_agency_transaction` compares type, principal, customer fee, commission supplied, float account, normalised customer identifier and provider reference, and the date when explicitly passed; mismatch raises `P0001` |
| A reversal is not its own original, and not itself | `CHECK agency_transactions_reversal_not_self`, `..._reversal_not_own_original` |
| The audit log records both values of a correction, and a reason where it matters | `CHECK agency_audit_correction_records_both_values`, `agency_audit_reason_required_where_it_matters` |

79 named CHECK constraints sit on the agency, journal and finance-settings
tables alone.

---

## 4. Authentication, sessions, RLS, privileged functions, branch isolation and roles

Counts from the merged 200-migration schema.

### 4.1 The shape of the security model

| Measure | Value |
| --- | --- |
| Tables in `public` | 90 |
| Tables with RLS **enabled** | **90 — all of them** |
| RLS policies | 136 |
| Tables with RLS enabled and no policy (default-deny) | 4: `membership_consent_challenges`, `rate_limit_counters`, `reference_formats`, `reference_sequences` — reachable only through definer functions, by design |
| Views | 59, of which **58** are `security_invoker` |
| `SECURITY DEFINER` views | **1** — `company_identity`, reviewed and recorded as an exemption by `20261106000300` |
| Functions in `public` | 360 |
| `SECURITY DEFINER` functions | 320 |
| …executable by `authenticated` | 130 |
| …**without** a pinned `search_path` | **0** |
| Roles | 4: `client`, `secretary_treasurer`, `manager`, `owner_admin` |
| Permissions | 117, with 256 role-permission grants |

`scripts/check-database-security.mjs` classifies all 130 reachable definer
functions against `config/database-security-baseline.json` and passes on the
merged schema with "No unreviewed privileged exposure". Classification A means
a business RPC that refuses with `42501`; the remainder are advisory notes
where the presence of an authorization helper would prove nothing either way.

### 4.2 Authentication and sessions

- Identity is derived from the **phone number** (ADR-013); `profiles.auth_user_id`
  is nullable (ADR-007) so a staff record can exist before an Auth user does.
- `current_profile_id()` returns a profile only when the account is **active**
  and **not** `must_change_password`. Disabling an account is therefore enforced
  by that function rather than by a revocation column (ADR-015), and the forced
  password change is a server-only operation (ADR-017). **137** functions call
  `current_profile_id()`.
- `require_business_identity()` is called by 8 functions, including
  `ledger_account_balance` once #19 merges; `20261103000100` introduced it to
  stop a definer RPC answering a caller with no business identity at all.
- The authenticated area is never prerendered or cached (ADR-012).
- Response headers are built per request in `lib/security/headers.ts` rather
  than statically in `next.config.ts`, because the CSP carries a per-response
  nonce with `'strict-dynamic'`: `Content-Security-Policy`, `X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`,
  `X-DNS-Prefetch-Control: off`, `Strict-Transport-Security: max-age=63072000;
  includeSubDomains` in production, and `Cache-Control: no-store` on
  authenticated responses. `poweredByHeader` is off.
- **Leaked-password protection is disabled on the hosted project** (Supabase
  security advisor, WARN). It is a one-switch change in the dashboard and
  belongs in §9.

### 4.3 Branch isolation

`user_can_see_branch(p_branch_id uuid)` is the single rule: a `NULL` branch
means Head Office, which sees everything; otherwise the caller must be assigned
to that branch. It appears in **43 `SECURITY DEFINER` function bodies** and in
**0 RLS policies** — and that is correct rather than alarming. `SECURITY
DEFINER` bypasses RLS, so a branch rule written only as a policy would be
bypassed by the very functions that do the work. The rule therefore lives where
the work happens. The cross-branch authorization gap closed in Phase 4B-S was
exactly this mistake made once, and the closure is asserted by
`tests/db/agency-security-closure.test.ts`.

### 4.4 Role permissions, as they bear on this release

| Capability | `owner_admin` | `manager` | `secretary_treasurer` | `client` |
| --- | --- | --- | --- | --- |
| `ledger:view` | ✓ | ✓ | ✓ | — |
| `agency:write` | ✓ | ✓ | ✓ | — |
| `agency:verify` | ✓ | ✓ | — | — |
| `agency:reverse` | ✓ | ✓ | — | — |
| `agency:reverse_cross_day` | ✓ | — | — | — |
| `agency:correct` | ✓ | ✓ | — | — |
| `agency:settlements` | ✓ | ✓ | — | — |
| `agency:reconcile` | ✓ | ✓ | — | — |
| `agency:providers` | ✓ | — | — | — |
| `agency:reports` | ✓ | ✓ | ✓ | — |

Two consequences worth stating plainly. First, a Secretary/Treasurer can record
an agency transaction but cannot verify, settle, reconcile or reverse one —
which is the maker-checker design, and the browser suite proves the controls
are absent from their screens rather than merely disabled. Second, **cross-day
reversal is Owner-only**, so an error found the next morning needs the Owner.
That is deliberate; it is also an operational fact the Owner should know before
the first week of trading.

### 4.5 Integrated regression evidence

The six database projects most exposed to #19's `ledger:view` guard were run
against the merged 200-migration schema:

| Project | Files | Tests | Result |
| --- | --- | --- | --- |
| `db` | 83 | 1,923 | **pass** |
| `agency` | 1 | 66 | **pass** |
| `agency-engine` | 1 | 64 | **pass** |
| `agency-security` | 1 | 21 | **pass** |
| `agency-settlement` | 1 | 78 | **pass** |
| `shared-till` | 1 | 6 | **pass** |
| | **88** | **2,158** | **all pass** |

The four seed projects (`seed`, `seed-reuse`, `seed-member-loans`,
`seed-benefits`) were not re-run here; they exercise demonstration seeding
rather than the guarded read path, and they pass on PR #26's own CI run. The
browser suite was likewise not re-run against the merged set — §6 lists it as
the one verification still outstanding before the merge.

---

## 5. Production environment, secrets, storage, deployment protections, backups and recovery

### 5.1 What is actually deployed

| | Value |
| --- | --- |
| Vercel project | `lending-manager` (`prj_1qpwIN5eEEDrsmcJzWJ9Cq5owwal`), team `mwesigwatrevorjoseph-9675s-projects` |
| Framework / runtime | Next.js, Node **24.x**, region **`dub1`** (Dublin) — co-located with Supabase `eu-west-1` |
| Production deployment | `dpl_9NSBbF2yBns8EFFhJo6PS2g8zain`, **READY**, commit **`64ea09c`** — the default-branch tip |
| Production alias | `lending-manager-git-1c0eae-mwesigwatrevorjoseph-9675s-projects.vercel.app` |
| Custom domain | **none** |
| Rollback candidates | the current production deploy and the one before it (`dpl_9W4nfLXRQw3canjyjeVmL6AgiYeX`, `b7f2aa7`) |
| Recent deployments | the last ten are all **preview** (`target: null`) from `phase4d/…`, including `20e6fcd` and `38633d8` |

**A merge will not deploy anything.** `vercel.json` carries
`git.deploymentEnabled: { "claude/intelligent-knuth-2r8mpw": false }` and has
done since 2026-11-01, and the current production deployment was created on
2026-11-04 — after that setting existed. So production is reached by an
explicit promotion, not by pushing to the default branch. That is a safe
default and it must be an explicit step in §9, or the release will merge, pass,
and change nothing that a user can see.

### 5.2 Environment variables and secrets

Five variables, every one marked `sensitive`, every one scoped to
**`production` only**, `hiddenProductionEnvCount: 0`:

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY` (visibility `secret`), `NEXT_PUBLIC_APP_ENV`,
`NEXT_PUBLIC_SITE_URL`.

No value was read, and none needs to be. Two consequences:

- The contract is satisfied. `lib/env.public.ts` requires
  `NEXT_PUBLIC_SUPABASE_URL` (https, full URL) and
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (rejecting a privileged key), defaults
  `NEXT_PUBLIC_APP_ENV`, and treats `NEXT_PUBLIC_SITE_URL` as optional.
  `lib/env.server.ts` treats `SUPABASE_SECRET_KEY` as optional at boot and
  rejects a publishable key supplied in its place.
- **No preview or development variables exist at all.** Preview deployments
  therefore build with no Supabase configuration, which is why 67 commits of
  agency work have reached Vercel without a single risk to the hosted project.
  It is also why there is no hosted-data smoke test available on a preview URL
  (§6).

`SUPABASE_SECRET_KEY` bypasses RLS. It is set only on production, only in
Vercel's secret store, and is reachable in code only through
`lib/env.server.ts`, guarded by an ESLint rule and a `server-only` import.

### 5.3 Storage

All six buckets on the hosted project are **private**, with size and MIME
limits — ADR-010 ("all storage buckets are private, including company assets")
holds in production, not just in the migrations:

| Bucket | Public | Max size | Types |
| --- | --- | --- | --- |
| `client-documents` | no | 10 MiB | JPEG, PNG, WebP, HEIC, PDF |
| `guarantor-documents` | no | 10 MiB | same |
| `loan-documents` | no | 10 MiB | same |
| `benefit-documents` | no | 10 MiB | same |
| `membership-consent` | no | 10 MiB | same |
| `company-assets` | no | 2 MiB | JPEG, PNG, WebP |

### 5.4 Deployment protections

| Control | State | Assessment |
| --- | --- | --- |
| Vercel SSO protection | **enabled**, `all_except_custom_domains` | With no custom domain, **every** URL including production requires Vercel team authentication. Staff cannot use the system. **Blocker B2** |
| Vercel password protection | disabled | fine once a custom domain exists and application auth is the gate |
| Vercel trusted IPs | disabled | optional; a Ugandan branch on mobile data has no stable IP, so not recommended |
| GitHub branch protection | **none on any branch**, including the default | **Blocker B6**. `docs/POLYTOS-BRANCH-PROTECTION-MANUAL-STEPS.md` describes the intended settings and they were never applied |
| Required status checks | consequently none | the four mandatory CI jobs — `checks, unit/integration, build`; `database (real PostgreSQL)`; `browser E2E (production build, fresh seed)`; `security release rehearsal (PostgreSQL 17, real Auth)` — can be bypassed by merging |
| Default-branch auto-deploy | disabled in `vercel.json` | deliberate; see §5.1 |

The branch-protection values to apply are already worked out in
`docs/POLYTOS-RELEASE-AUTHORIZATION-CHECKLIST.md` §Step 2, including the one
counter-intuitive value: **required approvals must be 0**, because there is a
single collaborator and GitHub forbids self-approval, so at 1 no pull request
could ever merge.

### 5.5 Hosted database health and advisories

PostgreSQL 17.11, `ACTIVE_HEALTHY`. Installed extensions are minimal and
appropriate: `plpgsql`, `supabase_vault`, `pgcrypto`, `uuid-ossp`, `pg_trgm`,
`pg_stat_statements`. **`pg_cron` is not installed**, so nothing is scheduled
server-side — worth knowing, because the business-date rollover and the
notification sweeps are driven by application reads, not by a cron job.

Supabase **security** advisor:

| Level | Finding | Count | Disposition |
| --- | --- | --- | --- |
| **ERROR** | `security_definer_view`: `public.company_identity` | 1 | **Accepted** — reviewed and recorded by migration `20261106000300` (PR #20) |
| **ERROR** | `security_definer_view`: **`public.__gate_probe`** | 1 | **Live defect.** A stray view that PR #19's `20261104000100` drops, guarded on its definition being exactly `select 1 as one;`. Still present on production today |
| WARN | `authenticated_security_definer_function_executable` | **117** | Expected. This is the classification-A surface governed by `config/database-security-baseline.json`; the merged schema has 130 and the check passes. The advisor cannot see a capability check inside a function body |
| WARN | `auth_leaked_password_protection` disabled | 1 | **Fix before launch.** One switch in the dashboard |
| INFO | `rls_enabled_no_policy` | 4 | By design — default-deny tables reached only through definer functions (§4.1) |

Supabase **performance** advisor: INFO only — 143 unindexed foreign keys
(overwhelmingly `*_by_fkey` actor columns that are never joined in a hot path)
and 115 unused indexes (expected on a database with no production traffic).
Neither is a release blocker. Revisit both after a month of real use, with
`pg_stat_statements` as the evidence rather than the advisor.

### 5.6 What the hosted database actually contains

| | |
| --- | --- |
| Profiles / role assignments | 6 / 6 — `owner_admin`, `manager`, `secretary_treasurer`. **No `client` account exists** |
| Branches | **1** |
| Clients · loans · payments | 28 · 35 · 470 |
| Journal entries · lines | 597 · 1,667, balanced |
| Memberships · savings accounts · benefit claims | 6 · 5 · 0 |
| Audit rows | 1,673 |
| Membership policy versions | 3 |

The policy versions deserve their own statement, because they are **Blocker
B5**:

| Version | Title | Status | Effective from | Enrolment | Savings | Member lending | Benefits | Financially enabled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.0 | Polytos membership programme — proposed terms | draft | 2026-11-01 | no | no | no | no | no |
| 2.0 | Polytos membership programme — official policy, management decisions of October 2026 | **draft**, unapproved, **no effective date** | — | no | no | no | no | no |
| **999.0** | **DEMONSTRATION ONLY — not the approved Polytos membership policy** | **active** | 2025-09-20 | **yes** | **yes** | no | no | no |

So the live, governing membership policy on production is a demonstration
policy, and the six memberships and five savings accounts that exist are
governed by it. Taking a real member's savings under a policy titled
"DEMONSTRATION ONLY" is not a software problem and no migration fixes it.

### 5.7 Backups and recovery

`docs/BACKUP-RESTORE.md` is unusually good: it records a **proven** restore
drill (dump → fresh database → row counts, financial fingerprints and the
reconciliation invariant re-checked, all matching), it explains why `analyze`
after a restore is not optional (25× slower dashboard reads without it), and it
states the disaster-recovery matrix and the forward-only migration rule.

It also names one launch condition: *"Confirm the tier and retention in the
Supabase dashboard before launch."*

**That condition fails.** The Supabase organisation `SALONGO` is on
`plan: free`, `tier: tier_free`. On the free tier there are **no managed daily
backups and no point-in-time recovery**, and free projects **pause when idle** —
the second project in the same organisation is already `INACTIVE`, which is what
that looks like. For a microfinance ledger holding real client savings this is
**Blocker B1**, and it is the single most serious finding in this audit. The
remedies, in order of preference:

1. Upgrade the organisation to Pro (daily backups plus PITR), confirm the
   retention window in the dashboard, and record it in
   `docs/BACKUP-RESTORE.md`; **or**
2. if the tier cannot change before launch, run the documented `pg_dump -Fc`
   daily from a trusted host, store it encrypted off the application host,
   retain 30 days, record checksums, and **rehearse one restore** — and accept
   in writing that recovery granularity is the last dump, not the last second.

Option 2 is a real mitigation, not a formality, but it requires someone to
actually run it every day. Option 1 is the right answer for money that belongs
to other people.

---

## 6. Hosted versus local verification: what is proven where, and what is not

### 6.1 What is proven, and on what

| Evidence | Where it runs | Covers the merged set? |
| --- | --- | --- |
| 2,158 database tests across six projects | local PostgreSQL 16, 200 migrations | **yes** (§4.5) |
| `check-database-security.mjs`, `audit-financial-arithmetic.mjs`, `verify-membership-upgrade.mjs` | local, 200 migrations | **yes** (§2.4) |
| 1,005 browser tests, production build, fresh seed | CI, PR #26 at `20e6fcd` | no — 198 migrations |
| Security release rehearsal, PostgreSQL **17**, real GoTrue | CI, PR #26 at `20e6fcd` | no — 198 migrations |
| Hosted ledger balance, migration history, advisories, storage, policy state | the hosted project, read-only | yes, as a *baseline* |
| `Supabase Preview` CI job | **skipped** | this is the evidence that nothing reached the hosted project |

### 6.2 The gaps, named

1. **No browser or real-Auth run exists on the merged 200-migration set.** The
   `ledger:view` guard sits beneath every screen that shows a balance; the
   database suites prove the engine, and the browser suites prove the screens.
   Those have only ever run without #19.
2. **The hosted project runs PostgreSQL 17; local runs 16.** The release
   rehearsal job exists precisely to cover that, and it has never run on the
   merged set.
3. **No preview deployment can reach the hosted database**, because no preview
   environment variables exist (§5.2). So there is no way to click through the
   real application against real hosted data before promoting it.
4. **There is no agency data on production at all** — no chart-of-accounts
   entries, no provider float tills, one branch. Any hosted agency rehearsal is
   testing a screen with nothing behind it until §10.3 is answered.
5. **There is no `client` account on production**, so the borrower portal
   cannot be exercised against hosted data (§7.4).
6. **`__gate_probe` still exists on production**, so the public security
   posture is today what PR #19 says it is, not what the chain assumes.

### 6.3 How to close them, safely

| Step | How | Why it is safe |
| --- | --- | --- |
| **G1** | Merge #19, then push the chain's head with #19 in its history, and let CI run all four mandatory jobs on the merged set | CI builds its own throwaway PostgreSQL and its own GoTrue; `Supabase Preview` stays skipped. Nothing hosted is touched |
| **G2** | Add `'20261104'` to `PHASE_PREFIXES` first (§2.4), so the rehearsal measures all 39 | one line, no schema change |
| **G3** | Before any production migration, take a manual `pg_dump -Fc` of the hosted database and record its sha256 | read-only on production; it is also the only rollback that exists on the free tier |
| **G4** | Apply the 39 migrations to a **Supabase branch** or a throwaway project restored from that dump, then re-run `check-database-security.mjs` and the hosted baseline queries against it | a copy, not production. This is the only way to see PostgreSQL 17 plus real hosted data plus the new schema together |
| **G5** | For a hosted application rehearsal, create **preview** environment variables pointing at that copy — never at production — and deploy the chain's head as a preview | the preview build then exercises real screens against a real but disposable database |
| **G6** | After the production migration, run `scripts/certify-production-readonly.mjs` (PR #19's `production-anonymous-smoke.yml`, also `workflow_dispatch`-able) and re-run the Supabase security advisor | GET-only and anonymous; it proves `__gate_probe` is gone and unauthenticated routes are denied |
| **G7** | Re-run the hosted baseline queries from §2.3 and confirm every figure is unchanged | `SELECT` only |

One thing **not** to do: do not point a preview deployment at the production
Supabase project in order to "test it properly". The reason no accident has
happened in 67 commits is that no preview build has ever held a production
credential.

---

## 7. Final user-acceptance scenarios

105 application routes, of which 17 are the agency module. These scenarios are
the minimum that a human must do, on the real deployed application, before the
first real client — each one chosen because it either moves money, enforces a
separation of duties, or is a thing the system refuses.

Run them in the order given: later scenarios consume what earlier ones create.
Record, for each, the figure before and the figure after. **A scenario that
"looks right" without a figure is not evidence.**

### 7.1 Owner / Admin

| # | Scenario | Route | Pass criterion |
| --- | --- | --- | --- |
| O1 | Sign in, be forced to change the bootstrap password, then reach the dashboard | `/`, `/account/password` | No route is reachable while `must_change_password` is set; afterwards all are |
| O2 | Create the second branch and assign a Manager and a Secretary to it | `/` admin area | A Head Office user sees both branches; a branch user sees one |
| O3 | Read the trial balance and confirm debits = credits | `/finance/trial-balance` | The two totals match, and match `sum(debit)`/`sum(credit)` on `journal_lines` |
| O4 | Approve a loan product's terms, then disburse a loan | `/loans/new`, `/loans/[id]` | A journal entry appears; Cash at Hand falls by the principal; the terms snapshot is written |
| O5 | Record a repayment and read the receipt | `/payments/new`, `/payments/[id]` | Allocation covers interest before principal; the receipt's balances are a snapshot, not the live figure |
| O6 | Record an expense above the approval threshold and approve it as a second step | `/finance/expenses/new`, `/finance/expenses` | The maker cannot approve their own; cash falls only on approval |
| O7 | Attempt a transfer larger than Cash at Hand | `/finance/transfers/new` | **Refused**, naming the account and both figures (`assert_cash_available`) |
| O8 | Reverse yesterday's agency transaction | `/agency/history/[id]` | Only the Owner can; a Manager is refused (`agency:reverse_cross_day`) |
| O9 | Read the provider register and confirm `requires_approval_above` is shown struck through and marked not enforced | `/agency/providers` | The figure is visible and explicitly not a control |
| O10 | Enable leaked-password protection, then set a known-breached password | Supabase dashboard, then `/account/password` | The change is **refused** |
| O11 | Confirm a restore | off-system | A `pg_dump` taken today restores into a fresh database and reproduces the §2.3 fingerprints exactly |

### 7.2 Manager

| # | Scenario | Route | Pass criterion |
| --- | --- | --- | --- |
| M1 | Verify an agency transaction a Secretary recorded | `/agency/pending` | One balanced journal entry; the audit trail reads `submit` then `post`/`verify` |
| M2 | Attempt to verify a transaction they recorded themselves | `/agency/pending` | **Refused** — "cannot be verified by the person who recorded it" |
| M3 | Open a pending transaction, have the Secretary amend the amount in another window, then verify | `/agency/pending` | **Refused** on the stale revision; after a reload, verification succeeds against the new figure |
| M4 | Certify a cash count a Secretary submitted | `/agency/reconciliation/cash` | Second officer stamped; a variance write-off is **refused** without `agency:variance_adjustment` |
| M5 | Certify a float statement | `/agency/reconciliation/float` | Variance sign is books-less-provider (opposite to a cash count); **no journal is written**; the difference then appears on `/agency/exceptions` |
| M6 | Settle a provider commission, then reverse it | `/agency/commission` | Balanced entries both ways; the second posting of the same statement reference is **refused**; balances return exactly |
| M7 | Remit a provider payable, then try to remit more than is outstanding | `/agency/payables` | The second is **refused** for net debit; nothing is written |
| M8 | Replenish a float till from the drawer | `/agency/float/replenish` | Exactly two balanced lines; the duplicate provider reference is **refused** |
| M9 | Read the end-of-day exception report and the agency reports | `/agency/exceptions`, `/agency/reports` | Every unresolved variance and unverified transaction is listed; a failed read says so rather than showing `UGX 0` |
| M10 | Attempt to see another branch's till | `/agency/float` | Not listed, and a direct URL is refused by the server |
| M11 | Approve a benefit claim, then attempt to pay it | `/benefits/approvals`, `/benefits/payments` | Approval succeeds; payment behaves per the policy flags in force |

### 7.3 Secretary / Treasurer

| # | Scenario | Route | Pass criterion |
| --- | --- | --- | --- |
| S1 | Register a client with a NIN and a document | `/clients/new` | The NIN is unique; the document lands in a private bucket |
| S2 | Record two agency transactions for two customers without reloading | `/agency/record` | **Two different idempotency keys**; two transactions; both customers' money recorded |
| S3 | Press *Record* twice quickly | `/agency/record` | One transaction only; the button is disabled while in flight |
| S4 | Make a submission fail, then retry it | `/agency/record` | The typed values survive; the **same** key is sent; one transaction results |
| S5 | Submit a cash count at end of day | `/agency/reconciliation/cash` | Recorded as open; they cannot certify their own count, and no certify control is shown |
| S6 | Try to reach commission settlement, payable settlement and float replenishment | `/agency/commission`, `/agency/payables`, `/agency/float/replenish` | Registers are readable where permitted; **no settlement, reversal or replenishment control appears at all**, and a direct POST is refused by the server |
| S7 | Record a loan repayment and print the receipt | `/payments/new` | As O5 |
| S8 | Enrol a member and record a savings contribution | `/membership/enrol`, savings | Only possible under an **active** policy, and the governing policy is named on the record |
| S9 | Attempt to view the company ledger | `/finance/ledger` | Permitted — a Secretary holds `ledger:view`. (A borrower is refused: §7.4) |

### 7.4 Borrower (client portal)

**There is no `client` account on the hosted project.** One must be created for
these, and that is itself a release step.

| # | Scenario | Pass criterion |
| --- | --- | --- |
| C1 | Sign in and see only their own loans, schedule and payment history | No other client's record is reachable, by any URL |
| C2 | Read their statement | Figures match the staff view of the same loan |
| C3 | Attempt a GL account balance (`ledger_account_balance` via the Data API) | **Refused with `42501`** once PR #19 is deployed. Before it, the call **succeeds** — this is the exposure #19 closes, and it is the single clearest demonstration of why #19 must ship |
| C4 | Attempt to read the trial balance | Zero rows — the view runs as the caller and RLS decides |
| C5 | Attempt another member's savings amount | Refused (`20261106000500`) |
| C6 | Attempt to redeem a consent code they were not issued | Refused, and the refusal spends no attempt (`20261106000200`) |

### 7.5 Scenarios to run only after the business decisions land

| # | Depends on | Scenario |
| --- | --- | --- |
| P1 | §10.1 Decision A | Attempt a disbursement, a savings withdrawal and a benefit payment larger than Cash at Hand. Today all three **succeed** and take the drawer negative. After the decision, the agreed behaviour must be demonstrated for each of the three |
| P2 | §10.3 provider activation | Post a live transaction for the first activated provider, verify it, settle its commission, and reconcile its float — end to end, with the agreed rate |
| P3 | §10.2 Decision L | If a threshold is adopted, show a transaction below it verified normally and one above it held for the named approver |
| P4 | §5.6 Policy | Approve a real policy version, transition the existing memberships, and confirm each membership's governing policy on its own record |

---

## 8. Unresolved decisions

Every item below is addressed to the **Product Owner**. None can be settled by
the engineering work, and each is stated as: the decision required, and what
shipping without it costs.

| # | Decision required | Release impact if left open | Blocker? |
| --- | --- | --- | --- |
| **A** | May Cash at Hand go negative on a **loan disbursement**, a **savings withdrawal** or a **benefit payment** — and if not, what happens at the counter when it would? | The three paths listed in §3.2 will pay out money the drawer does not hold. The ledger stays balanced and auditable, so the loss is silent: a negative Cash at Hand that nobody is told about at the moment it is created. Recommendation in §10.1 | **Yes — B3** |
| **L** | Should `requires_approval_above` gate verification; at what amount; and whose approval does it need? | The system ships with **no amount ceiling** on agency transactions. A 50,000 and a 50,000,000 need identical authority. The column is stored, shown struck through, and read by nothing. Options in §10.2 | No — accept knowingly |
| **C** | The **commission model** for each provider (immediate versus deferred recognition) | The engine posts the model recorded against the provider. The nine seeded values are the specification's §4.1 defaults, flagged `is_provisional` | **Yes — B4** |
| **F** | The **commission rate** for each provider (basis points, or a fixed amount, or an explicit zero) | `NULL` throughout. A provider cannot leave the provisional state without a basis (`CHECK agency_providers_confirmed_states_commission`), so no provider can be activated | **Yes — B4** |
| **G** | **Which providers operate at which branch**, and the opening float for each till | No float till is provisioned anywhere. `ensure_agency_float_account()` creates them once the answer is known | **Yes — B4** |
| **H** | Per-type **transaction ceilings** (`max_single_transaction`) | The live-readiness gate refuses any posting for a type with no ceiling, so this is not merely advisory — it is a precondition of activation | **Yes — B4** |
| **Policy** | Approve a real **membership policy version** and retire the active `999.0` "DEMONSTRATION ONLY" policy | Real member savings would be governed by a demonstration policy. Policy 2.0 is draft, unapproved and has no effective date | **Yes — B5** |
| **Demo data** | What happens to the 28 clients, 35 loans, 470 payments, 6 memberships and 5 savings accounts now on production | Real and demonstration records would share one book and one trial balance. Three honest options: keep and label them, segregate them to a demonstration branch, or remove them under a recorded authorisation. This audit deleted nothing | **Yes, in effect** |
| **Tier** | Upgrade the Supabase organisation from **free**, or accept manual daily dumps as the only backup | No managed backups, no PITR, and idle projects pause. §5.7 | **Yes — B1** |
| **Access** | Register a **custom domain** (and decide whether Vercel SSO stays for the Vercel-generated URLs) | Staff cannot reach the application: SSO protects every non-custom-domain URL. §5.4 | **Yes — B2** |
| **Protection** | Authorise the GitHub **branch-protection** settings, with required approvals at **0** | Nothing enforces the four mandatory CI jobs at merge. §5.4 | **Yes — B6** |
| **B** | Is the ledger account-code allocation acceptable | Structural only; nothing depends on the answer | No |
| **I** | F1 error-code reclassification (`docs/POLYTOS-F1-AUTHORIZATION-ERROR-CLASSIFICATION.md` §4) | Roughly two thirds of capability refusals are classified as business-rule violations rather than authorization failures, so monitoring that watches for `42501` sees a third of them | No — but it degrades alerting |

---

## 9. Staged release

Ten stages, each ending in a gate. A gate is a **stop**: if any line in it is
not true, the release does not proceed, and the recovery column says what to do
instead. **OP** = operator, **PO** = Product Owner, **ENG** = engineering.

### Stage 0 — Business decisions and environment · PO

1. Settle Decision **A** (§10.1) and record the answer.
2. Approve the provider commercial terms for **at least one** provider —
   Decisions **C**, **F**, **G**, **H** (§10.3). One provider is enough to go
   live; nine are not required.
3. Decide Decision **L**, or record that it is knowingly left open (§10.2).
4. Approve a real membership policy version and decide the fate of the active
   `999.0` demonstration policy.
5. Decide the fate of the demonstration data on production.
6. Upgrade the Supabase organisation from the free tier, or sign off manual
   daily dumps as the backup regime (§5.7).
7. Register a custom domain for the application (§5.4).
8. Authorise the GitHub branch-protection settings.

> ### GATE 1 — business readiness
> - [ ] Decision A answered in writing
> - [ ] One provider's commission model, rate, ceiling, branch and opening float approved
> - [ ] A real policy version approved, with an effective date
> - [ ] Demonstration-data disposition decided
> - [ ] Backup regime decided: Pro tier **or** signed-off daily dumps
> - [ ] Custom domain registered
>
> **NO-GO** if any is unchecked. Nothing below is worth doing first: Stage 5
> applies migrations that cannot be rolled back, and Stage 9 takes a real
> client's money.

### Stage 1 — Repository readiness · ENG

1. Add `'20261104',` to `PHASE_PREFIXES` in
   `scripts/verify-membership-upgrade.mjs` on the chain (§2.4), and correct the
   stale migration counts in the comment in
   `tests/db/financial-authorization.test.ts` (§1.5).
2. If Decision A requires code, implement it on its own branch stacked on #26,
   with a test that reproduces the current behaviour first.
3. Apply branch protection to the default branch: the four CI jobs required and
   `strict`, `enforce_admins` true, required approvals **0**, force pushes and
   deletions forbidden.

> ### GATE 2 — repository readiness
> - [ ] `PHASE_PREFIXES` includes `20261104`
> - [ ] Branch protection active, the four jobs required, approvals at 0
> - [ ] A pull request with a deliberately failing check cannot be merged

### Stage 2 — Merge PR #19 · PO

1. Take #19 out of draft; confirm CI green at `3d09f93`.
2. Merge #19 into `claude/intelligent-knuth-2r8mpw`.
3. Do **not** deploy or migrate yet.

> ### GATE 3 — #19 merged
> - [ ] Default branch contains `20261104000100` and `20261104000200`
> - [ ] Migration count on the default branch is 163
> - [ ] CI green on the default branch after the merge

### Stage 3 — Merge the chain · PO

Merge in order, each after its own CI run is green on the merged content:
**#20 → #21 → #22 → #23 → #24 → #25 → #26**. Take each out of draft
immediately before merging it, not earlier.

> ### GATE 4 — chain merged
> - [ ] Default branch holds **200** migrations
> - [ ] All four mandatory jobs green on the default branch head, in one run, first attempt
> - [ ] That run includes the browser suite and the PostgreSQL 17 release rehearsal on the merged set — the gap §6.2 names
> - [ ] `Supabase Preview` skipped

### Stage 4 — Backup and rehearsal on a copy · OP

1. `pg_dump "$DATABASE_URL" -Fc -f polytos-pre-release-$(date -u +%Y%m%dT%H%M%SZ).dump`
   from a trusted host, using the direct hosted `DATABASE_URL`. Record the
   sha256. Store it encrypted, off the application host.
2. Record the §2.3 baseline figures: 161 migrations; debits = credits =
   89,649,530; 0 unbalanced; 597 entries; 1,667 lines; 28 clients; 35 loans;
   470 payments; 6 memberships; 5 savings accounts; 1,673 audit rows.
3. Restore the dump into a throwaway database, run `analyze`, and re-check
   those figures (§5.7's drill).
4. On that copy, apply the 39 migrations in §2.2's order, then run
   `check-database-security.mjs` against it and re-check every baseline figure.

> ### GATE 5 — rehearsed on real data
> - [ ] A dump exists, with a recorded checksum, stored off-host
> - [ ] It restores and reproduces every baseline figure
> - [ ] All 39 migrations apply to the restored copy with no error
> - [ ] The security check passes on the copy
> - [ ] Not one financial figure moved on the copy
>
> **NO-GO** if the dump has not been restored. Migrations are forward-only; on
> the free tier this dump is the only rollback that exists.

### Stage 5 — Apply migrations to production · PO

1. Put the application in maintenance, or pick an hour with no counter activity.
2. Apply the 39 migrations **in the order of §2.2**, one at a time, stopping at
   the first error.
3. Re-run the §2.3 baseline queries.
4. Re-run the Supabase security advisor.

> ### GATE 6 — production schema
> - [ ] Hosted migration list shows **200** versions, ending `20261114000100`
> - [ ] Debits = credits = 89,649,530 and 0 unbalanced entries, unchanged
> - [ ] Every other baseline figure unchanged
> - [ ] `__gate_probe` **gone** from the advisor's `security_definer_view` finding; only `company_identity` remains
> - [ ] No new ERROR-level advisory
>
> **Recovery:** halt. Do **not** apply more migrations and do **not** attempt a
> reverse migration. Restore from the Stage 4 dump, `analyze`, re-verify the
> fingerprints, and re-plan.

### Stage 6 — Deploy and promote · OP

1. Confirm the five production environment variables are present and correct
   (names only; §5.2).
2. Promote a deployment built from the default-branch head to **production** —
   explicitly, because `vercel.json` disables automatic deployment of that
   branch (§5.1).
3. Point the custom domain at it and confirm TLS.
4. Decide and apply the SSO posture: a custom domain is exempt from Vercel SSO,
   so application authentication becomes the only gate on it. Keep SSO on the
   Vercel-generated URLs.

> ### GATE 7 — application deployed
> - [ ] Production deployment commit equals the default-branch head
> - [ ] The custom domain serves the application over TLS, without a Vercel SSO interstitial
> - [ ] `Strict-Transport-Security`, `Content-Security-Policy` with a per-response nonce, `X-Frame-Options: DENY` present on an authenticated response
> - [ ] The previous production deployment is still a rollback candidate
>
> **Recovery:** request a rollback to the previous production deployment. An
> application rollback does **not** undo Stage 5 — if the schema is the problem,
> the recovery is a restore, not a rollback.

### Stage 7 — Smoke tests on production · OP

Ten minutes, in this order. Every one is read-only or trivially reversible.

| # | Smoke test | Expected |
| --- | --- | --- |
| K1 | `scripts/certify-production-readonly.mjs` (PR #19's workflow, `workflow_dispatch`) | Liveness passes; every unauthenticated route denied; artefact saved |
| K2 | Anonymous request to `/finance/trial-balance` | Redirected to sign-in, never rendered |
| K3 | Owner signs in on the custom domain | Dashboard renders; no 500s in the runtime logs |
| K4 | Owner opens `/finance/trial-balance` | Debits = credits = 89,649,530 |
| K5 | Owner opens `/agency` | Renders; tills empty until §10.3 — and an unreadable figure says so rather than showing `UGX 0` |
| K6 | Borrower account attempts `ledger_account_balance` via the Data API | **`42501`** |
| K7 | Secretary signs in and opens `/agency/record` | The form renders with a fresh idempotency key; the service list reflects only confirmed, active providers |
| K8 | Supabase security advisor | Exactly one `security_definer_view` ERROR (`company_identity`); leaked-password protection **enabled** |
| K9 | Vercel runtime logs and runtime errors for the first 15 minutes | No unhandled errors |

> ### GATE 8 — production smoke
> - [ ] K1 through K9 all as expected
> - [ ] No financial figure changed by any smoke test
>
> **Recovery:** roll the application back (Gate 7) and investigate. The schema
> can stay: nothing in the 39 migrations changes a figure, and the previous
> application build runs against it.

### Stage 8 — User-acceptance testing on production · PO

Run §7.1 through §7.4 in order, then §7.5 for whichever decisions landed in
Stage 0. Record before-and-after figures for every money movement.

> ### GATE 9 — UAT
> - [ ] Every Owner, Manager, Secretary and borrower scenario passes
> - [ ] Every refusal scenario actually refuses — O7, M2, M3, M7, S3, S6, C3, C5, C6
> - [ ] The trial balance still balances after all of it
> - [ ] Demonstration data has been dealt with as Stage 0 decided

### Stage 9 — First real client · PO

> ### FINAL GATE — go live
> - [ ] Gates 1–9 all closed
> - [ ] Backups confirmed working **after** the migration, not only before
> - [ ] A real approved policy version is active and `999.0` is retired
> - [ ] At least one agency provider is confirmed, active, with a ceiling, a rate and a funded float till — or agency banking is deliberately not offered on day one
> - [ ] `docs/BACKUP-RESTORE.md`, `docs/INCIDENT-RUNBOOK.md` and the on-call owner are current
> - [ ] Decision A's answer is implemented, or its risk is accepted in writing with the counter staff told what to do when the drawer is short

### 9.1 Recovery procedure, by what went wrong

| Symptom | First action | Recover from |
| --- | --- | --- |
| A migration fails mid-sequence | Stop. Apply nothing further | Stage 4 dump; `analyze`; re-verify §2.3 fingerprints |
| Figures moved after Stage 5 | Stop all writes; put the app in maintenance | Stage 4 dump. Then find which migration did it on a copy, not on production |
| The application errors after promotion | Roll back to the previous production deployment | Previous build. The schema stays |
| A bad bulk data change later | Stop writes | PITR if the tier was upgraded; otherwise the most recent daily dump — which is the practical argument for Stage 0 item 6 |
| Credentials exposed | Rotate `SUPABASE_SECRET_KEY` and the Supabase keys; force re-authentication | n/a |
| Total database loss | Maintenance mode | Latest provider backup, or the latest `pg_dump` |

### 9.2 Abort conditions — stop the release immediately

- Debits ≠ credits at any point, or any unbalanced journal entry appears.
- A hosted migration version appears that is not in git.
- A borrower account can read a GL balance after Stage 5.
- A Secretary/Treasurer can verify, settle, reconcile or reverse anything.
- A cash or float figure on a screen where the underlying query failed.
- The Stage 4 dump cannot be restored.

---

## 10. Business approvals required before launch

Three packs. Each states what is true now, what the choices are, and what the
Product Owner must supply. **Nothing in this section has been implemented, and
no figure in it has been invented.**

### 10.1 Decision A — lending cash sufficiency

#### What is true today

`finance_settings.allow_negative_cash` exists and defaults to `false`.
`assert_cash_available(account, amount)` locks the account, reads that flag,
reads the balance, and refuses with `P0001` naming the account and both figures.
Nine posting functions call it. **Three money-out paths do not:**

| Path | Function | What happens today |
| --- | --- | --- |
| **Loan disbursement** | `post_disbursement_journal` | A loan is disbursed for more than the drawer holds. The entry balances; Cash at Hand goes negative; nobody is told |
| **Savings withdrawal** | `post_savings_withdrawal` | A member withdraws savings the branch does not physically have |
| **Benefit payment** | `post_benefit_payment` | A condolence or medical benefit is paid from a drawer that cannot cover it |

And the refund-shaped reversals — `post_reversal_journal`,
`reverse_savings_transaction`, `reverse_membership_fee`,
`reverse_meeting_fine_payment`, `reverse_benefit_payment` — pay cash back out
without the check either.

The **concurrency** half of this is already closed: PR #25 moved cash-account
locking into `post_journal()` itself, so every one of the 29 posting functions
serialises the accounts it touches. Two clerks can no longer spend the same
shilling. One clerk can still spend a shilling that was never there.

#### The recommendation

**Cash at Hand must not go negative.** A till is a physical drawer; a negative
balance in it is not a liability, an overdraft or a timing difference — it is
an arithmetic statement that cannot be true. Extend `assert_cash_available()`
to the three paths and to the five refund paths, so that every function that
takes cash out of a drawer refuses when the drawer cannot cover it, with the
same message and the same `allow_negative_cash` escape the rest of the system
already honours.

The reason to recommend it rather than simply do it is that **the refusal lands
on a person**. A clerk who cannot complete an approved disbursement needs to
know what to do instead, and that is a business instruction, not a code change.

#### Impact, path by path

| Path | What changes for the user | What the business must have ready |
| --- | --- | --- |
| **Loan disbursement** | An approved loan cannot be disbursed when the branch drawer is short. The approval stands; the payout waits | A funding route: a transfer from Bank to Cash at Hand (`/finance/transfers/new`, already asserts sufficiency), or part-disbursement if that is allowed, or a stated rule that disbursements happen only on funded days |
| **Savings withdrawal** | A member is told their withdrawal cannot be paid **today**, at the counter, in front of them | This is the sharpest one. A member whose savings exist in the ledger is being told the branch has no cash. The business needs a script, a same-day funding route, and probably a daily minimum till balance |
| **Benefit payment** | A bereavement or medical payment is refused when the drawer is short | Benefits are time-sensitive and emotional. A pre-funding rule for approved claims is the humane answer |
| **Refund reversals** | A mistaken receipt cannot be refunded in cash until the drawer can cover it | Usually trivial, because the money just came in. Worth including for consistency |

#### The options

| | Option | Consequence |
| --- | --- | --- |
| **A1** | **Refuse (recommended).** Extend the assertion to all eight paths; `allow_negative_cash` remains the single documented escape, owner-controlled | A drawer never goes negative. Some payouts wait for funding. Honest figures; occasional operational friction |
| **A2** | **Allow, but say so.** Let the posting proceed and raise a notification and an end-of-day exception for every negative till | Nothing is blocked; the Owner learns the same day. Still produces a figure that cannot be physically true, and relies on somebody reading the exception |
| **A3** | **Refuse selectively.** Assert on savings withdrawals and benefit payments (member money) but not on disbursements (company money) | Defensible — a disbursement shortfall is the company's own problem — but it leaves two different rules for one drawer, which is how operational mistakes are made |
| **A4** | **Do nothing** | The status quo. Every path stays as described above, and the risk is accepted without being recorded anywhere a clerk can see |

#### What the Product Owner must supply

1. The chosen option.
2. If A1 or A3: whether `allow_negative_cash` may ever be set, and by whom.
3. If A1 or A3: what the counter does when a withdrawal is refused — the words
   the clerk says, and the funding route.
4. Whether a **minimum till balance** should exist (a floor above zero), which
   is a different and larger question than "not negative".
5. Whether the rule is per branch till or per branch in aggregate.

#### If approved, what implementation would look like

One migration adding `perform public.assert_cash_available(<cash account>,
<amount>)` to the eight functions, and a test per path that reproduces today's
behaviour first and then asserts the refusal — plus browser coverage for the
savings withdrawal, because that refusal is the one a member will see. No new
table, no new setting, no change to any existing figure. The engineering is
small; the operational preparation is not.

**Not implemented. Awaiting approval.**

### 10.2 Decision L — approval thresholds

#### What is true today

`agency_transaction_types.requires_approval_above` is a nullable `bigint`,
stored per transaction type, **read by nothing**. `NULL` means "nobody decided",
and the Phase 4D provider screen shows the figure struck through and labelled
not enforced. Verification is gated on capability alone: a Manager may verify a
50,000 transaction and a 50,000,000 transaction with identical authority.

A related but **different** column already exists and already matters:
`max_single_transaction` is a hard ceiling, and the live-readiness gate refuses
to post any transaction of a type that does not state one (§3.4). That is
Decision **H**, and it must be answered to activate a provider at all. Decision
**L** is the softer question stacked on top of it: between zero and the hard
ceiling, is there a figure above which a *higher* authority is required?

#### The choices, stated as policies rather than numbers

| | Policy | What it would mean in the engine | What the PO must supply |
| --- | --- | --- | --- |
| **L1** | **No approval threshold.** A hard ceiling per type (Decision H) is the only amount control; capability alone decides who verifies | No engine change. The column stays, read by nothing, visibly marked as such — or is dropped so that nobody later mistakes it for a control | Nothing. Record that it is deliberate |
| **L2** | **The ceiling is the control.** Set `max_single_transaction` low enough that anything needing more scrutiny simply cannot be recorded | No engine change beyond Decision H. Simple, blunt: a large legitimate transaction becomes impossible rather than escalated | One ceiling per transaction type |
| **L3** | **Threshold requires a named higher role.** Above the figure, verification requires `owner_admin` (or a new capability, e.g. `agency:verify_high_value`) rather than any `agency:verify` holder | `verify_agency_transaction` reads the type's threshold against the snapshot amount and refuses a verifier who lacks the higher capability. A new permission, a new refusal, new tests, a screen that explains why a Manager cannot verify this one | The figure per type (or per provider), **and** which role is the higher authority |
| **L4** | **Threshold requires a third person.** Above the figure, recorder, verifier and approver must be three distinct people | The strongest control and the largest change: a new lifecycle state, a new queue screen, new audit actions. Realistic for a bank; heavy for a branch with three staff | The figure, the third role, and what happens when only two staff are present |

#### Recommendation on process, not on the number

Ship with **L1**, recorded as a deliberate acceptance, and revisit after a
month of real volume — because the right threshold is a function of the
transaction sizes a branch actually sees, and nobody has that data yet.
Choosing a figure now would be inventing one.

But note the risk being accepted, plainly: with L1, the only amount control is
Decision H's hard ceiling, and a single Manager can verify anything beneath it.

**No threshold invented. Awaiting the policy choice.**

### 10.3 Provider activation decision table

#### The five conditions the database imposes

`agency_transaction_live_readiness_guard()` refuses any transition out of
`draft` unless all five hold. A provider is not "activated" by a button; it is
activated by these being true:

1. `agency_service_providers.is_provisional = false` — the commercial terms are
   confirmed.
2. `agency_service_providers.is_active = true`.
3. The transaction type `is_active = true`.
4. The type states a `max_single_transaction` — no silent "unlimited".
5. The provider states a commission basis — `commission_rate_bps` **or**
   `commission_fixed`, where `0` is a perfectly good answer but `NULL` is not.
   This is also a CHECK constraint, so a provider cannot leave the provisional
   state without it.

And operationally, two more:

6. A **float till** must exist at the branch for a `provider_float` provider
   (`ensure_agency_float_account()`), and be funded via
   `post_float_replenishment` — which itself asserts the funding account can
   cover it.
7. A `cash_payable` provider must name a **payable account**, which is already
   seeded (`2210` school fees, `2220` bank agency).

#### What is seeded now — all nine provisional and inactive

| Provider | Code | Category | Float model | Commission model (seeded) | Income a/c | Payable a/c | Transaction types |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MTN Mobile Money | `MTN_MOMO` | mobile money | provider float | deferred | 4510 | — | DEPOSIT, WITHDRAWAL |
| Airtel Money | `AIRTEL_MONEY` | mobile money | provider float | deferred | 4510 | — | DEPOSIT, WITHDRAWAL |
| UEDCL Yaka Electricity | `UEDCL` | utility | provider float | deferred | 4530 | — | YAKA |
| NWSC Water | `NWSC` | utility | provider float | deferred | 4530 | — | WATER_BILL |
| DStv | `DSTV` | TV subscription | provider float | deferred | 4550 | — | SUBSCRIPTION |
| GOtv | `GOTV` | TV subscription | provider float | deferred | 4550 | — | SUBSCRIPTION |
| Lycamobile Airtime & Data | `LYCAMOBILE` | airtime and data | provider float | **immediate** | 4560 | — | AIRTIME, DATA |
| Stanbic Bank Agency | `STANBIC` | agency banking | **cash payable** | deferred | 4520 | **2220** | DEPOSIT, WITHDRAWAL |
| School Fees Collection | `SCHOOL_FEES` | school fees | **cash payable** | deferred | 4540 | **2210** | FEES |

Every row is `is_provisional = true`, `is_active = false`,
`commission_rate_bps = NULL`, `commission_fixed = NULL`, and every transaction
type has `max_single_transaction = NULL` and `requires_approval_above = NULL`.
The commission models above are the specification's §4.1 defaults, not agreed
terms — that is what `is_provisional` records.

`SCHOOL_FEES` is a generic placeholder: a real deployment adds **one provider
row per institution**, so that each school's payable is its own balance.

#### The table to complete and approve

One row per provider the business intends to offer. A provider with any blank
cell cannot be activated, and the database will say so.

| Provider | Commission model (immediate / deferred) | Agreed rate (bps or fixed UGX, or explicit 0) | `max_single_transaction` per type (UGX) | Branch(es) | Opening float / payable arrangement | Signed contract on file? | Ready to activate? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MTN Mobile Money | | | DEPOSIT: <br> WITHDRAWAL: | | Float till per branch; opening amount: | | |
| Airtel Money | | | DEPOSIT: <br> WITHDRAWAL: | | Float till per branch; opening amount: | | |
| UEDCL Yaka | | | YAKA: | | Float till; opening amount: | | |
| NWSC Water | | | WATER_BILL: | | Float till; opening amount: | | |
| DStv | | | SUBSCRIPTION: | | Float till; opening amount: | | |
| GOtv | | | SUBSCRIPTION: | | Float till; opening amount: | | |
| Lycamobile | | | AIRTIME: <br> DATA: | | Float till; opening amount: | | |
| Stanbic Bank Agency | | | DEPOSIT: <br> WITHDRAWAL: | | No float — payable `2220`; settlement cadence: | | |
| School Fees — *name the institution* | | | FEES: | | No float — payable `2210`; remittance cadence: | | |

#### Notes that bear on the commercial decision

- **Immediate versus deferred changes the journal**, not just a report. Under
  `immediate`, commission income is recognised at the point of transaction;
  under `deferred` it accrues and is recognised on settlement. Changing a
  provider's model after transactions exist does not rewrite them — the model
  is snapshotted on each posted transaction (§3.4) — so the first choice
  matters.
- **A rate of zero is a valid answer** and the right one for a provider that
  pays no commission. It must be entered as `commission_fixed = 0`, not left
  `NULL`.
- **Float is working capital.** A `provider_float` till must be funded from Cash
  at Hand or Bank before a single customer is served, and
  `post_float_replenishment` will refuse to fund it from a drawer that cannot
  cover it. The opening float is therefore a cash-flow decision, not a
  configuration value.
- **A `cash_payable` provider is the opposite risk**: the company holds the
  customer's cash and owes the institution. The payable grows until it is
  remitted, and the remittance cadence is what keeps it honest.
- **One provider is enough to launch.** Activating MTN alone is a complete,
  verifiable business line. Nine unconfirmed providers on a screen are nine
  things that will be refused.

**No provider activated. No rate entered. No ceiling set. Awaiting approval.**

---

## 11. What this audit did not do

- No pull request was merged, taken out of draft, or modified.
- No migration was applied to the hosted project.
- No deployment, promotion or rollback.
- No deployment setting, environment variable, secret, Auth setting, branch
  protection or tier was changed.
- No provider was activated; no commission rate, ceiling or threshold was
  entered or invented.
- Policy 2.0 was not published; the `999.0` demonstration policy was not
  touched.
- No demonstration data was deleted or altered. Every hosted statement in this
  report came from a `SELECT`, a metadata read or an advisor read.
- The only writes anywhere were to throwaway local PostgreSQL databases built
  to answer §2.4, and to this file. Those databases were dropped and the two
  PR #19 migration files copied in for the §4.5 test run were removed; the
  working tree carries nothing but this report.

### Where the evidence lives

| Claim | Reproduce with |
| --- | --- |
| Chain SHAs, ahead/behind, #19 is a sibling | `git rev-list --count`, `git merge-base --is-ancestor` |
| Conflict-free merge | `git merge-tree --write-tree origin/phase4d/… origin/security/…` |
| 200 migrations apply together | apply `supabase/migrations/*.sql` of the merged tree in order to a fresh database |
| 2,158 database tests pass on the merged set | `npx vitest run --project db` (and `agency`, `agency-engine`, `agency-security`, `agency-settlement`, `shared-till`) with the two `20261104*` files present |
| Security and arithmetic gates | `scripts/check-database-security.mjs`, `scripts/audit-financial-arithmetic.mjs` |
| Upgrade measurement, and the `PHASE_PREFIXES` defect | `scripts/verify-membership-upgrade.mjs` — read the list it prints |
| Hosted migration history, advisories, policy state, balances | Supabase: `list_migrations`, `get_advisors`, and the `SELECT`s quoted in §2.3, §5.6 |
| Production deployment, env var names, protections | Vercel: `get_project`, `filter_project_envs`, `list_deployments --target production` |
| Tier | Supabase `get_organization` → `plan: free` |
