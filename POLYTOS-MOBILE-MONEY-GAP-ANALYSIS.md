# POLYTOS — Mobile Money: gap analysis and accounting design

**Date:** 2026-11-09 · **Branch:** `phase4e/mobile-money-2026-11-09`, created from
`phase4d/agency-banking-interface-2026-11-08` @ `38633d8` · **Status:** design
only — **no migration and no implementation code has been written.**

The PR stack is untouched: #19 through #26 all still open and draft at their
audited SHAs. PR #19's two security migrations remain a separate, independent
merge.

---

## 1. What was inspected

| | |
| --- | --- |
| Migrations | the 33 agency and ledger-serialisation files from `20261107000100` to `20261114000100`, plus the chart of accounts and the journal invariants they build on |
| Schema | 10 agency tables, 11 agency views, the 79 named CHECK constraints on the agency, journal and finance-settings tables |
| Functions | the agency transaction lifecycle, commission engine, posting, reversal, settlement, replenishment, reconciliation, correction, lock and assertion functions |
| Permissions | the 11 `agency:*` capabilities and their 4-role grants |
| Application | 14 route files, 9 components, 15 data readers, 17 server actions |
| Tests | 253 agency tests across 9 files (66 foundation, 64 engine, 14 security, 78 settlement, 6 shared-till, 6 unit, 4 integration, 16 + 15 browser) |

The headline: **most of this workstream already exists.** The deposit and
withdrawal accounting is already exactly what the brief asks for, commission
receivable is already a posted pair against GL `1310`, and per-line float
accounts, per-line float reconciliation and branch cash reconciliation are
already built and tested. What is genuinely missing is narrower than it looks,
and it is listed in §3.

---

## 2. What already exists

### 2.1 The chart of accounts anticipated this work

| Code | Name | Already used for | Needed by this brief |
| --- | --- | --- | --- |
| `1010-BR…` | Cash at Hand (per branch) | counter cash | deposits, withdrawals, float purchases and sales |
| `1030-BR…` | Bank (per branch) | bank balances | float purchases from bank funds, sales settled to bank |
| `1310` | **Agency Commission Receivable** | the deferred commission accrual | commission earned but not yet paid into float |
| `1320.<CODE>.<BRANCH>[.T<n>]` | Agency float account, **one ledger account per agent line** | electronic float | every line's independent balance |
| `4510` | Mobile Money Commission | commission income | commission income, per provider |
| `4570` | **Agency Service Fees** | customer fees at the counter | the optional fee on a float sale |
| `5960` | Agency Float Over and Short | reconciliation write-offs | unchanged |

Nothing new is needed in the chart of accounts. `1310` and `4570` were created
in Phase 4A for precisely the two things this brief asks for.

### 2.2 Agent lines already exist, with the right shape

`agency_provider_float_accounts` is keyed `unique (provider_id, branch_id,
till_name)` and each row owns **its own ledger account**
(`ledger_account_id uuid not null unique`). `ensure_agency_float_account(
provider, branch, till_name)` mints the account code — `1320.MTN_MOMO.BR2601`
for the first line, `…​.T2`, `…​.T3` for the rest — requires the Owner-only
`agency:providers` capability, and is already granted to `authenticated`.

So "multiple agent lines per provider and branch, each with an independent
float balance" is **already implemented**, and so is independent per-line:

- **float balance** — `agency_float_balances` view carries `till_name` and the balance;
- **float reconciliation** — `agency_float_reconciliations` is keyed on `float_account_id`;
- **transaction register** — `agency_transactions.float_account_id` records the line on every posting;
- **float replenishment** — `agency_float_replenishments` is keyed on `float_account_id`.

### 2.3 The deposit and withdrawal accounting is already correct

`post_agency_transaction()` builds one balanced entry from two configured
facts — the provider's `float_model` and the type's `direction` — for every
provider, with no provider identity anywhere in the code. The brief's
requirement 3 is satisfied by the existing `provider_float` shapes:

**Deposit** — the customer hands cash over the counter and we send value from
the line's float. *Cash at Hand increases, the line's float decreases.*

**Withdrawal** — we pay cash out and the provider credits the line's float.
*Cash at Hand decreases, the line's float increases.*

Under the **deferred** commission model the commission is not in the principal
legs at all; it is accrued as its own pair, `Dr 1310 · Cr <provider income>`,
inside the same entry. MTN MoMo and Airtel Money are both seeded `deferred`.
**That is already "earned at the transaction date, held as commission
receivable, not added to available float."**

Resulting balances are computed by the engine from the amount, the fee and the
commission. The cashier supplies amounts, never balances — `post_journal()` is
the only writer and `ledger_account_balances` is derived, so there is no column
anywhere for a cashier to type a resulting balance into.

### 2.4 Controls already in place, to be preserved rather than rebuilt

| Control | Where |
| --- | --- |
| Duplicate protection | `idempotency_key` with the Phase 4D-F replay guard (a reused key with different details raises `P0001`); `unique (float_account_id, provider_reference)` on replenishments; `unique (provider_id, provider_statement_ref)` on commission settlements |
| Maker-checker | `CHECK agency_transactions_verifier_not_submitter`; `verify_agency_transaction(id, expected_revision)` refuses stale figures |
| Balanced double entry | two `DEFERRABLE INITIALLY DEFERRED` constraint triggers on `journal_entries` and `journal_lines` |
| Atomic posting | one entry per transaction carrying both the principal and the commission pair |
| Authorised reversal | `reverse_agency_transaction()`; `agency:reverse`, and `agency:reverse_cross_day` for a prior day |
| Float sufficiency | `assert_agency_float_available()`, reading only `allow_negative_agency_float` |
| Cash sufficiency | `assert_cash_available()` on every agency cash-out path |
| Serialisation | `post_journal()` locks every cash-kind account in the entry; `lock_agency_provider_balance()` before `lock_ledger_balances()`, the latter sorted by account id |
| Branch isolation | `user_can_see_branch()` in 43 definer function bodies |
| Audit | `agency_transaction_audit_log`, append-only, with both values of a correction |

---

## 3. Gap analysis

Verdicts: **Reuse** (no change), **Extend** (small additive change to something
that exists), **New** (does not exist).

### 3.1 Requirement 2 — provider and agent-line management

| Item | Existing artefact | Verdict | What is missing |
| --- | --- | --- | --- |
| Multiple lines per provider and branch | `agency_provider_float_accounts`, `ensure_agency_float_account()` | **Reuse** | — |
| Independent float balance per line | `agency_float_balances`, one `1320.*` account per line | **Reuse** | — |
| Independent transaction register per line | `agency_transactions.float_account_id` | **Extend** | `agency_transaction_history` does not expose `float_account_id` or `till_name`, so the register cannot be filtered by line |
| Independent commission receivable per line | commission is posted per transaction, which carries the line | **Extend** | `agency_commission_outstanding(provider, branch)` and `agency_commission_summary` aggregate by provider **and branch only**. No per-line figure exists |
| Independent settlement history per line | `agency_commission_settlements` | **Extend** | the table has no `float_account_id`, so a payout cannot be attributed to a line |
| Independent reconciliation per line | `agency_float_reconciliations.float_account_id` | **Reuse** | — |
| Owner controls to register a line | `ensure_agency_float_account()` with `agency:providers` | **Extend** | no server action, no screen. `/agency/providers` is read-only |
| Owner controls to **edit** a line | — | **New** | no editable identity fields at all: no agent MSISDN, no provider agent code, no display label, no notes |
| Owner controls to **activate / deactivate** a line | `is_active` column | **New** | nothing writes it; no guard against deactivating a line that still holds float |
| Audit of those admin acts | `public.audit_log` (general, with `entity_type`/`entity_id`/`old_values`/`new_values`) | **Extend** | `agency_transaction_audit_log.transaction_id` is `NOT NULL`, so line administration cannot be logged there. The general log is the right home and is unused for agency configuration |
| Provider identity kept out of the engine | `post_agency_transaction()` reads only `float_model` and `direction` | **Reuse** | — |

### 3.2 Requirement 3 — manual deposits and withdrawals

| Captured field | Exists? | Note |
| --- | --- | --- |
| Provider | ✅ `provider_id` | |
| **Specific agent line** | ✅ `float_account_id` | the record form already offers postable tills |
| Deposit or withdrawal | ✅ `agency_transaction_types.direction` | |
| Transaction amount | ✅ `principal_amount` | |
| **Actual commission from the confirmation message** | ⚠️ `commission_supplied` | the column exists, but supplying a figure that differs from the configured rate currently demands an **Owner-authorised commission exception on every transaction**. §3.3 |
| Provider transaction reference | ✅ `provider_reference` | |
| Customer identifier and details | ✅ `customer_identifier`, `customer_name` | |
| Transaction **date** | ✅ `transaction_date date` | the business date, drives posting and reconciliation |
| Transaction **time** | ❌ | **New (small).** Only the recording instant (`created_at`) exists. The provider's own timestamp is not stored |
| Optional notes | ✅ `description` | |
| Resulting balances computed, never typed | ✅ | derived from the journal; no column exists to type one into |

**Verdict: Reuse the whole posting path.** Two additive changes: a nullable
`transacted_at timestamptz` for the provider's own instant (the business date
stays authoritative for posting, per ADR-004), and the commission change below.

### 3.3 Requirement 4 — commission accounting

This is the largest genuine gap, and it is two separate things.

**(a) The configured-rate requirement, for mobile money only.**

Today, three things require a configured rate:

1. `agency_commission_for(provider, principal)` **refuses a provider that
   configures neither a rate nor a fixed amount**;
2. `CHECK agency_providers_confirmed_states_commission` forbids leaving the
   provisional state without a rate or a fixed amount;
3. the live-readiness guard's fifth condition repeats (2) as a trigger.

And `post_agency_transaction()` treats a supplied figure that differs from the
computed one as an **exception** needing `agency:commission_exception`, which
only the Owner holds. For mobile money, where the real commission arrives in a
confirmation message and varies by amount band, that would mean an Owner
authorisation per transaction. Unworkable, and it would train the Owner to
rubber-stamp.

**Proposed design — a separate `commission_source`, not a new
`commission_model`.** `commission_model` currently means *when* income is
recognised (`immediate` | `deferred`). Overloading it with *where the amount
comes from* would conflate two independent facts and would change the meaning
of `commission_model_applied` on 4,000 words of existing snapshot
documentation and of the `commission_model <> 'deferred'` guard in
`record_commission_settlement()`.

So: add `agency_service_providers.commission_source text not null default
'configured'`, constrained to `('configured', 'reported')`.

| | `configured` (every existing provider) | `reported` (MTN, Airtel) |
| --- | --- | --- |
| Amount | from `commission_rate_bps` or `commission_fixed` | **from `commission_supplied`, which becomes mandatory** |
| `commission_supplied` is NULL | means "the configuration decides" | **refused** — "nobody typed a figure" must stay distinguishable from a stated zero |
| `commission_supplied = 0` | a stated zero, flagged against the computed figure | a valid answer: this transaction paid no commission |
| Exception required | yes, when supplied ≠ computed | **no** — the reported figure *is* the basis |
| `commission_computed` | the configuration's figure | equal to the reported figure, so the exception path never fires |
| `commission_basis_applied` | `rate` \| `fixed` \| `zero` | new value `reported` |
| Rate required to confirm the provider | yes | **no** — the CHECK and the readiness trigger both gain `or commission_source = 'reported'` |
| Recognition timing | unchanged | unchanged: `deferred`, so `Dr 1310 · Cr 4510` |

Nothing changes for any `configured` provider: the relaxation is predicated on
a column that defaults to `configured`, and the other four readiness
conditions — provider confirmed, provider active, type active, **type states a
`max_single_transaction`** — are untouched. **No provider is activated and no
rate is invented by this change**; it only removes *rate* from the list of
things a mobile-money provider must state, and leaves *ceiling* and
*confirmation* exactly where they are.

**(b) Paying the accumulated commission into the line's float.**

Today `record_commission_settlement()` exists, settles against `1310`,
supports partial settlement, refuses more than is outstanding, and has a
reversal — but `assert_agency_settlement_account()` **explicitly refuses an
agency float account**: *"Use the branch's cash at hand or its bank account …
not an agency float account."* That refusal is correct for the account it was
written for and wrong for mobile money, where MTN and Airtel pay commission
**into the agent line's own float**.

| Item | Existing | Verdict | Missing |
| --- | --- | --- | --- |
| Receivable account, partial payouts, over-settlement refusal, statement reference uniqueness, reversal with a reason, correction path | `agency_commission_settlements`, `record_commission_settlement()`, `reverse_commission_settlement()`, the correction migration | **Extend** | — |
| Payout destination = the line's float | refused by `assert_agency_settlement_account()` | **Extend** | a float-destination path |
| Per-line attribution and outstanding | per provider+branch only | **New (views + function)** | `agency_commission_outstanding_by_line()`, `agency_commission_by_line` |
| Monthly reconciliation of receivable against payouts | `agency_commission_summary` is a running total | **New (view)** | a per-period opening/earned/paid/closing statement |
| Income not recognised twice | the payout touches no income account | **Reuse** | — |

### 3.4 Requirement 5 — float operations

| # | Operation | Existing | Verdict |
| --- | --- | --- | --- |
| 1 | Internal transfer between agent lines | — | **New.** `post_float_replenishment()` requires the funding account to be branch cash or bank, so a float-to-float movement is refused |
| 2 | Float purchase from another agent | `post_float_replenishment()` | **Extend** — the journal is identical; only counterparty metadata is missing |
| 3 | Float purchase from a service centre | `post_float_replenishment()` | **Extend** — same |
| 4 | Float purchase using bank funds | `post_float_replenishment()` | **Reuse** — a branch bank account is already an accepted funding account |
| 5 | Float sale to an external agent | — | **New.** The legs reverse and an optional fee leg appears |
| 6 | Float sale settled into a bank account | — | **New** — same function, bank as the receiving account |

### 3.5 Requirement 6 — reconciliation

| Reconciliation | Existing | Verdict |
| --- | --- | --- |
| Daily electronic float against the provider's balance, per line | `submit_agency_float_reconciliation()` / `approve_agency_float_reconciliation()`, maker ≠ checker, variance visible, write-off needs `agency:variance_adjustment` **and** evidence | **Reuse** |
| Branch physical cash | `submit_agency_cash_reconciliation()` / `approve_agency_cash_reconciliation()` | **Reuse** |
| Commission earned against the provider's reported total for a period | — | **New** |
| Monthly commission receivable against actual payouts | — | **New (view)** |
| Discrepancies stay visible until resolved | `agency_end_of_day_exceptions`, `agency_variance_report` | **Extend** — add the two new kinds |

### 3.6 Requirement 7 — dashboards and reports

| Item | Existing | Verdict |
| --- | --- | --- |
| Agency landing, float, history, pending, commission, payables, reconciliation, exceptions, reports screens | 14 route files, 9 components, the POLYTOS table design system, mobile-first, 1,005 browser tests | **Reuse** |
| Separate MTN and Airtel operational sections | — | **New**, but as a **provider-scoped route template** driven by the provider table, not two hardcoded sections |
| Per-line balances and registers on those screens | `agency_float_balances` has `till_name`; the history view does not | **Extend** |
| Consolidated Mobile Money report without mixing balances or double-counting transfers | `agency_commission_summary`, `agency_daily_cash_movement` | **New (view)** — an internal line-to-line transfer must be reported in its own column and excluded from float-in and float-out totals, or every transfer is counted twice |

### 3.7 Requirement 8 — security

| Item | Verdict |
| --- | --- |
| Role permissions, branch isolation, sessions, RLS, locking, audit | **Preserve unchanged.** No existing grant is widened by this design |
| New capabilities | one proposed: `agency:float_trade` (§5.4), plus a recommendation **not** to grant it to cashiers at launch (§9, OD-7) |
| Lending, savings, benefits, membership policy, Agent Banking posting | **Untouched.** The only shared-code change is additive and predicated on `commission_source`, which every existing provider leaves at `configured` |

---

## 4. Accounting design

Every entry below is one journal entry, balanced on its own, posted by
`post_journal()` and nothing else. Figures are illustrative UGX; `BR2601` is
the existing branch code and `1320.MTN_MOMO.BR2601` the first MTN line.

### 4.1 Deposit — already implemented, stated for confirmation

Customer deposits **100,000** into their wallet. Confirmation message reports
commission **700**. No customer fee.

| Account | Dr | Cr |
| --- | --- | --- |
| `1010-BR2601` Cash at Hand | 100,000 | |
| `1320.MTN_MOMO.BR2601` MTN line float | | 100,000 |
| `1310` Agency Commission Receivable | 700 | |
| `4510` Mobile Money Commission | | 700 |
| | **100,700** | **100,700** |

Cash at Hand **+100,000**, line float **−100,000**, receivable **+700**,
income **+700**, available float **unchanged by the commission**.

### 4.2 Withdrawal — already implemented

Customer withdraws **50,000**. Reported commission **300**. Customer fee
**500** charged at the counter.

| Account | Dr | Cr |
| --- | --- | --- |
| `1320.MTN_MOMO.BR2601` MTN line float | 50,000 | |
| `1010-BR2601` Cash at Hand | | 49,500 |
| `4570` Agency Service Fees | | 500 |
| `1310` Agency Commission Receivable | 300 | |
| `4510` Mobile Money Commission | | 300 |
| | **50,300** | **50,300** |

Note the existing fee convention: on a withdrawal the fee is **netted out of
the cash handed over** (the customer receives 49,500), and on a deposit the
customer hands over principal **plus** the fee. This is existing behaviour and
is listed as **OD-5** for confirmation rather than changed.

### 4.3 Commission payout into the line's float — new path, existing table

MTN pays **45,000** of accumulated commission into the MTN line's float, their
reference `MTNCOM-2026-10`.

| Account | Dr | Cr |
| --- | --- | --- |
| `1320.MTN_MOMO.BR2601` MTN line float | 45,000 | |
| `1310` Agency Commission Receivable | | 45,000 |
| | **45,000** | **45,000** |

**No income account is touched**, so income cannot be recognised twice: it was
recognised once, per transaction, at §4.1 and §4.2. The float rises only now,
when the money actually arrives. Partial payouts are the normal case and need
nothing special — the refusal is `payout > outstanding for this line`, so any
smaller figure simply leaves a balance.

Refused: a payout larger than that line's outstanding receivable; a repeated
provider reference for the same line; a provider whose `commission_model` is
not `deferred`; a line the actor's branch cannot see; an inactive line.

### 4.4 Float purchase — existing journal, new metadata

**From a service centre or another agent, paid in cash** — 500,000 of float
received, 500,000 cash paid, counterparty "Kalerwe Agent Services", their
reference `KAS-8841`.

| Account | Dr | Cr |
| --- | --- | --- |
| `1320.MTN_MOMO.BR2601` MTN line float | 500,000 | |
| `1010-BR2601` Cash at Hand | | 500,000 |

**Using bank funds** — identical, with `1030-BR2601` Bank in place of Cash at
Hand. Already supported today.

The journal is exactly what `post_float_replenishment()` already posts; the
only additions are the classification and counterparty columns. Cash
sufficiency is already asserted on the funding account, and a repeated
reference for the same line is already refused.

**One amount, deliberately.** The brief names a single figure for a purchase —
"the actual float received" — so this design posts one amount on both legs. If
a branch ever pays 500,500 for 500,000 of float, that difference has nowhere to
go in this design, and inventing an account for it is exactly the kind of
silent assumption the brief forbids. **OD-1.**

### 4.5 Float sale — new

**Without fee**, 200,000 of float sold to an external agent, settled in cash:

| Account | Dr | Cr |
| --- | --- | --- |
| `1010-BR2601` Cash at Hand | 200,000 | |
| `1320.MTN_MOMO.BR2601` MTN line float | | 200,000 |

**With fee**, the cashier enters a fee of **2,000**; the system computes total
proceeds **202,000** and recognises the fee as income separately:

| Account | Dr | Cr |
| --- | --- | --- |
| `1010-BR2601` Cash at Hand | 202,000 | |
| `1320.MTN_MOMO.BR2601` MTN line float | | 200,000 |
| `4570` Agency Service Fees | | 2,000 |
| | **202,000** | **202,000** |

**Settled into a bank account** — identical with `1030-BR2601` Bank receiving
the proceeds.

No rate, percentage or default is applied anywhere: the fee is a cashier-entered
non-negative integer, and `fee = 0` is the "sell without fee" case recorded as
a stated zero rather than a null. Total proceeds are computed, never typed.

Refused: a sale exceeding the line's available float (`assert_agency_float_
available`, which honours `allow_negative_agency_float` and nothing else); a
negative fee; a repeated counterparty reference for the same line; a receiving
account that is not the selling branch's cash or bank; an unauthorised actor.

**No credit sales.** Every sale in this design settles in the same entry, so
a sale on credit is structurally impossible: there is no receivable leg and no
counterparty account. That stays out pending separate approval, as instructed.

### 4.6 Internal transfer between agent lines — new

300,000 moved from the MTN first line to the MTN second line, same branch:

| Account | Dr | Cr |
| --- | --- | --- |
| `1320.MTN_MOMO.BR2601.T2` receiving line | 300,000 | |
| `1320.MTN_MOMO.BR2601` sending line | | 300,000 |

No cash moves, no income arises, and consolidated float is unchanged — which is
precisely why the consolidated report must show transfers in their own column
and exclude them from float-in and float-out totals (§3.6).

Refused: a transfer between **different providers** (MTN float cannot become
Airtel float — a physical impossibility, not a policy); a transfer to the same
line; an inactive line at either end; more than the sending line holds; a
branch the actor cannot see at **either** end. Cross-branch transfers are
**OD-3**.

### 4.7 Reversals

Each new operation gets the same treatment the existing ones have: the original
entry is kept, a mirrored contra entry is posted with a reason and a named
reverser, and the row's status becomes `reversed` with `reversed_by`,
`reversed_at` and `reversal_reason` moving together under the existing
`…_reversed_is_complete` / `…_unreversed_is_clean` constraint pattern.

One correction is required in the existing reversal. `reverse_commission_
settlement()` asserts **cash** availability on the settlement account, because
reversing a cash settlement takes cash back out. On the new float-destination
path the reversal takes **float** back out, so it must assert
`assert_agency_float_available()` instead. Reversing with the wrong assertion
would be a silent way to overdraw a float account.

### 4.8 The invariant that ties the subsidiary ledger to the general ledger

`1310` is a single GL account shared by every provider and every line.
Per-line receivable is therefore a **subsidiary** figure derived from the
transaction and payout records, not from the GL. The control is:

> for every line: `commission earned − commission paid out − commission
> reversed = outstanding`, and `Σ outstanding over all lines = the balance of
> GL 1310`.

That equality will be asserted as a database test after every scenario in the
test plan, because it is the one statement that catches a payout posted
against the wrong line, a double recognition, or a reversal that forgot the
receivable.

---

## 5. Proposed schema changes

Additive throughout. No column is dropped, no existing constraint is loosened
except the two predicated on `commission_source` in §5.2.

### 5.1 Agent-line identity and administration

`agency_provider_float_accounts` gains:

| Column | Type | Purpose |
| --- | --- | --- |
| `label` | `text not null default ''` | the human name of the line, editable. **`till_name` is not editable** — it is embedded in the ledger account code `1320.<CODE>.<BRANCH>.T<n>`, so renaming it would make the code lie |
| `line_msisdn` | `text` | the agent line's own number, shape-checked against the existing `lib/domain/phone.ts` Ugandan format |
| `agent_code` | `text` | the provider's own agent or till identifier, as printed on their statement |
| `opened_on`, `closed_on` | `date` | when the line started and stopped being used |
| `notes` | `text` | |
| `updated_by` | `uuid` | who last changed it |

New functions, all requiring `agency:providers`:

- `register_agency_agent_line(provider, branch, till_name, label, msisdn, agent_code, opened_on, notes)` — wraps the existing `ensure_agency_float_account()` and records the identity in one transaction.
- `update_agency_agent_line(id, label, msisdn, agent_code, notes)` — identity only; never `till_name`, never the ledger account.
- `set_agency_agent_line_active(id, active, reason)` — a reason is required in both directions.

Audit: triggers on `agency_provider_float_accounts` and
`agency_service_providers` writing `entity_type`, `entity_id`, `old_values`,
`new_values` and the actor into the existing general `public.audit_log`, which
already carries exactly those columns and is already append-only.

Deactivation guard: **OD-4**.

### 5.2 Commission source

- `agency_service_providers.commission_source text not null default 'configured'`, `CHECK (commission_source in ('configured','reported'))`.
- `CHECK agency_providers_confirmed_states_commission` → `is_provisional or commission_source = 'reported' or commission_rate_bps is not null or commission_fixed is not null`.
- The live-readiness guard's fifth condition gains the same `commission_source = 'reported'` branch. **Conditions 1–4 are untouched**, so a provider still cannot post until it is confirmed, active, has an active type and that type states a `max_single_transaction`.
- `CHECK` that a `reported` provider states neither a rate nor a fixed amount — so the two sources cannot both be configured and silently disagree.
- `agency_commission_reconcile(provider, principal, supplied)` gains the `reported` branch: supplied is mandatory, becomes both `commission_amount` and `commission_computed`, basis `reported`.
- `agency_transactions.commission_source_applied text` — the snapshot, beside the five snapshot columns that already exist, so a later change of source cannot rewrite what a posting recognised.
- `agency_transactions_snapshot_basis_valid` extended to accept `reported`.

### 5.3 Commission payout per line

- `agency_commission_settlements.float_account_id uuid references agency_provider_float_accounts(id)`, nullable: `NULL` is a cash or bank settlement exactly as today, non-null is a payout into that line's float.
- `CHECK`: when `float_account_id` is not null, `settlement_account_id` **must equal** that line's `ledger_account_id`, so the two cannot drift.
- `unique (float_account_id, provider_statement_ref) where float_account_id is not null and provider_statement_ref is not null` — per-line duplicate protection alongside the existing per-provider index.
- New `record_agency_commission_payout(float_account_id, amount, payout_date, provider_reference, notes)` — resolves provider and branch from the line, locks `lock_agency_provider_balance()` then `lock_ledger_balances([line ledger, 1310])`, refuses more than that line's outstanding, writes the settlement row and posts §4.3. Capability `agency:settlements`.
- `agency_commission_outstanding_by_line(float_account_id)` and the view `agency_commission_by_line` — earned, paid, reversed, outstanding per line.
- `reverse_commission_settlement()` gains the float branch described in §4.7.
- New `journal_entries.source_type` values: `agency_commission_payout`, `agency_commission_payout_reversal`.

### 5.4 Float operations

- `agency_float_replenishments` gains `source_kind text not null default 'provider_service_centre'` constrained to `('provider_service_centre','external_agent','bank','cash')`, plus `counterparty_name text` and `counterparty_reference text`. `post_float_replenishment()` gains the matching parameters, keeping its current signature working.
- New table `agency_float_sales` — `float_account_id`, `provider_id`, `branch_id`, `receiving_account_id`, `sale_date`, `float_amount`, `fee_amount bigint not null default 0`, `total_proceeds` (computed and checked equal to `float_amount + fee_amount`), `counterparty_name`, `counterparty_reference`, status and the reversal quartet. `CHECK fee_amount >= 0`, `CHECK float_amount > 0`, `unique (float_account_id, counterparty_reference)` where both are present.
- New table `agency_float_transfers` — `provider_id`, `from_float_account_id`, `to_float_account_id`, `from_branch_id`, `to_branch_id`, `transfer_date`, `amount`, `reference`, `notes`, status and the reversal quartet. `CHECK from <> to`.
- New functions `post_agency_float_sale(...)`, `reverse_agency_float_sale(...)`, `post_agency_float_transfer(...)`, `reverse_agency_float_transfer(...)`.
- New `journal_entries.source_type` values: `agency_float_sale`, `agency_float_sale_reversal`, `agency_float_transfer`, `agency_float_transfer_reversal`.
- New capability `agency:float_trade` for purchases, sales and transfers, granted to `owner_admin` and `manager` only at launch. **OD-7.**

### 5.5 Reconciliation

- New table `agency_commission_reconciliations` — `float_account_id`, `period_start`, `period_end`, `system_commission_earned`, `provider_reported_commission`, `variance`, `variance_means`, `notes`, `status`, `created_by`, `reconciled_by`, `reconciled_at`, with the existing maker ≠ checker and open-is-clean / closed-is-complete constraint pattern, and `unique (float_account_id, period_start, period_end)`.
- **Certification posts no journal.** The earned figure is already in the books; a genuine difference is corrected through a transaction correction or an authorised commission exception, never by a plug on certification. **OD-2.**
- New view `agency_commission_receivable_statement` — per line, per period: opening outstanding, earned, paid, reversed, closing outstanding.
- `agency_end_of_day_exceptions` and `agency_variance_report` extended with the commission-reconciliation kinds, so an unresolved commission variance stays visible on the screens that already show unresolved variances.

### 5.6 Registers and reporting

- `agency_transaction_history` gains `float_account_id` and `till_name`, so the register can be read per line.
- New view `agency_mobile_money_dashboard` — per line: float balance, today's and the period's deposits and withdrawals, commission earned, commission outstanding, float purchased, float sold, fee income, transfers in and out, and the open reconciliation count.
- New view `agency_mobile_money_consolidated` — per provider and in total, with **transfers in their own column** and excluded from float-in and float-out, and balances never summed across providers.

### 5.7 Transaction time

- `agency_transactions.transacted_at timestamptz` — the provider's own instant, nullable, display and reconciliation only. `transaction_date` remains the business date that drives posting, in Africa/Kampala, per ADR-004. **OD-12.**

---

## 6. Proposed migration sequence

Ten migrations, each independently reviewable. None is written yet.

| # | File | Contents |
| --- | --- | --- |
| 1 | `20261115000100_agency_agent_line_identity.sql` | §5.1 columns, shape checks, the general-audit triggers |
| 2 | `20261115000200_agency_agent_line_administration.sql` | `register_`, `update_`, `set_…_active` functions and grants |
| 3 | `20261115000300_agency_commission_source.sql` | §5.2: the column, the two relaxations, `agency_commission_reconcile`, the snapshot column |
| 4 | `20261115000400_agency_commission_payout.sql` | §5.3: the settlement column and checks, `record_agency_commission_payout`, the reversal branch, per-line outstanding |
| 5 | `20261115000500_agency_float_purchase_sources.sql` | §5.4 replenishment extension |
| 6 | `20261115000600_agency_float_sales.sql` | the sales table and its two functions |
| 7 | `20261115000700_agency_float_transfers.sql` | the transfers table and its two functions |
| 8 | `20261115000800_agency_commission_reconciliation.sql` | §5.5 table, submit and certify functions |
| 9 | `20261115000900_agency_mobile_money_views.sql` | §5.6 views and the register extension |
| 10 | `20261115001000_agency_float_trade_permissions.sql` | `agency:float_trade`, grants, and the `transacted_at` column |

`scripts/verify-membership-upgrade.mjs`'s `PHASE_PREFIXES` must gain
`'20261115'` in the first of these, or the upgrade verifier will classify them
as released schema — the same defect the release audit found for `20261104`.

---

## 7. Application layer plan

| Area | Plan |
| --- | --- |
| Provider-scoped section | `app/(app)/agency/money/[providerCode]/` — dashboard, lines, record, register, commission, float operations, reconciliation. One template, parameterised; MTN and Airtel are **data**, and navigation is generated from the active mobile-money providers |
| Consolidated | `app/(app)/agency/money/` — the consolidated report of §5.6 |
| Owner line administration | `app/(app)/agency/providers/[providerCode]/lines/` — register, edit, activate, deactivate, with the audit trail shown |
| New forms | agent line, commission payout, float purchase, float sale (with the with-fee / without-fee choice and a computed total), float transfer, commission reconciliation |
| Reuse | `components/agency/*` — `DataTable`, `badges`, `lifecycle-controls`, `settlement-forms`, `settlement-registers`, `reconciliation-forms`, `read-failure`, and the controlled-field, one-key-per-submission `record-form` pattern |
| Readers | extend `lib/data/agency.ts`, keeping the `AgencyRows` / `AgencyReadFailure` outcome type so a failed financial read never renders as `UGX 0` |
| Actions | extend `lib/agency/actions.ts`, keeping `authorize()` first, `P0001` messages passed through verbatim, and the revision-aware verification pattern |
| Design | mobile-first, the existing POLYTOS table design system, no new dependency |

---

## 8. Security and concurrency plan

- **No existing grant widens.** `agency:float_trade` is new and goes to `owner_admin` and `manager`; every other capability keeps its current four-role grants.
- **Every new function** is `SECURITY DEFINER` with `SET search_path = ''`, checks `user_can_see_branch()` on every branch it touches, and refuses with `42501` for authorisation and `P0001` for business rules.
- **Lock order is unchanged and extended consistently**: `lock_agency_provider_balance(provider, branch)` first, then `lock_ledger_balances(sorted account ids)`. For a cross-branch line transfer, the two provider-balance locks must be taken in a deterministic order — **by branch id** — or two opposing transfers can deadlock. This will be written as a test, not a comment.
- **Float sufficiency** on every float-out path; **cash sufficiency** on every cash-out path. The lending-side gap (Decision A in the release audit) is **not** touched by this workstream.
- **Append-only audit** everywhere: the agency transaction log for transactions, the general `audit_log` for line administration.

---

## 9. Open business decisions — answers needed before implementation

These are the points where the approved requirements do not determine the
accounting or the authority. **None will be implemented on an assumption.**

| # | Question | Why it cannot be assumed | Effect if unanswered |
| --- | --- | --- | --- |
| **OD-1** | On a float **purchase**, if the cash paid differs from the float received (a premium or discount), which account takes the difference? | The brief names one amount for purchases and a fee only on sales. Candidates are `5960` Agency Float Over and Short, a new expense account, or refusing the entry | Purchases will post one amount on both legs and **refuse** a mismatch. Branches that pay a premium cannot record it |
| **OD-2** | When the provider's reported commission differs from ours, what is the remediation? | The brief says certification must not silently change balances. Correcting individual transactions, posting an authorised adjustment to `1310`/`4510`, or tracking the variance indefinitely are three different controls | Variances will be **tracked and visible** with no posting route. Permanent differences will accumulate on the exceptions screen |
| **OD-3** | Are internal transfers between agent lines in **different branches** permitted? | Physically a provider can move float between branches; operationally it crosses a cash-custody boundary | Transfers will be **same-branch only**. Cross-branch rebalancing would need a later change |
| **OD-4** | May a line be deactivated while it still holds float, has unverified transactions, or has outstanding commission receivable? | Refusing is safer; allowing with a reason may be operationally necessary when a provider closes a line without notice | Deactivation will be **refused** unless float is zero and nothing is outstanding |
| **OD-5** | Confirm the existing fee convention: on a withdrawal the customer fee is netted out of the cash handed over; on a deposit it is collected on top | It is existing Phase 4B behaviour, not something this brief states | Unchanged. If the intent differs, it is a change to a tested posting path |
| **OD-6** | Is every float sale settled in full in the same entry? | The brief excludes credit sales pending approval, which this design enforces structurally | Sales settle immediately. A part-settled sale is impossible |
| **OD-7** | May cashiers (`secretary_treasurer`) purchase, sell or transfer float — and if so, must it be verified by a second person? | Today float replenishment needs `agency:settlements` (Manager/Owner). A float sale is a cash-out to an external party with a self-entered fee and no provider receipt to reconcile against, and float operations have **no maker-checker step** at all | **Recommendation: no.** `agency:float_trade` goes to Manager and Owner only. If cashiers must do it, a verification step should be built first |
| **OD-8** | Is a provider payment reference always available for a commission payout? | Duplicate protection depends on it; the existing indexes are partial, so a null reference silently loses duplicate protection | A payout without a reference will be accepted but **not** duplicate-protected, exactly as today's settlements |
| **OD-9** | Is the commission period a calendar month in Africa/Kampala, or the provider's own statement period? | They differ, and reconciliation compares our figure to theirs over "the same period" | Periods will be caller-supplied start and end dates, with no calendar assumption |
| **OD-10** | What happens when a transaction is **reversed after** its commission has already been paid out? | The reversal credits `1310` back, which can drive a line's outstanding receivable **negative** — we would owe the provider commission already received | The reversal will be **refused** when it would make the line's outstanding negative, with a message naming both figures. The alternative is to allow a negative outstanding as a payable |
| **OD-11** | *Dependency, not ambiguity.* A `max_single_transaction` per transaction type is still required to activate any provider (Decision H) | The live-readiness guard refuses posting without it, and this design does not relax that | MTN and Airtel stay inactive. Nothing can post against them |
| **OD-12** | Is the provider's transaction timestamp available at the counter, and is it required or optional? | A required field nobody can fill stops the counter | `transacted_at` will be **optional**; `transaction_date` stays mandatory |

Two further standing items from the release audit are unchanged and still
block a release, not this development: lending cash sufficiency (Decision A)
and the approval of provider commercial terms.

---

## 10. Test plan

Against real PostgreSQL throughout. The existing suites stay intact; new ones
are added beside them.

| Suite | New coverage |
| --- | --- |
| `tests/db/agency-mobile-money.test.ts` (new project `agency-money`) | reported commission accepted with no configured rate; a null reported figure refused; a stated zero accepted; the `configured` path unchanged for every other provider; per-line commission earned; the §4.8 subsidiary-to-GL equality after every scenario |
| `tests/db/agency-commission-payout.test.ts` | payout into the line's float posts §4.3; partial payouts; over-payout refused; duplicate reference refused; reversal restores both balances and asserts **float** sufficiency; per-line attribution; OD-10's refusal once decided |
| `tests/db/agency-float-operations.test.ts` | purchase from each source kind; purchase from bank; sale without fee; sale with fee recognising `4570` separately; sale exceeding float refused; negative fee refused; transfer between lines; cross-provider transfer refused; same-line transfer refused; duplicate references refused; every reversal |
| `tests/db/agency-money-reconciliation.test.ts` | commission earned versus reported for a period; maker ≠ checker; certification writes **no** journal; variance stays visible on the exceptions view; the monthly receivable statement ties to `1310` |
| `tests/db/agency-agent-lines.test.ts` | register, edit, activate, deactivate; `till_name` immutable; `agency:providers` required; every act written to `audit_log`; the deactivation guard |
| `tests/db/agency-money-concurrency.test.ts` | two concurrent sales from one line; a sale against a simultaneous deposit; two opposing line transfers (the deadlock case); a payout against a simultaneous withdrawal — each asserting one winner and a correct final balance |
| `tests/unit`, `tests/integration` | fee and total-proceeds arithmetic; the with-fee / without-fee form; one key per submission on each new form; a failed read rendering `AgencyReadError` and **no figure** |
| `tests/e2e/specs/agency-money.write.spec.ts` | browser-to-database for each new operation, in the existing dedicated write-test project with fresh fixtures, against the seed's `DEMO_MTN` and `DEMO_AIRTEL` providers — the real `MTN_MOMO` and `AIRTEL_MONEY` rows stay provisional and inactive |
| `scripts/verify-membership-upgrade.mjs` | the ten new migrations added to `PHASE_PREFIXES`, so the upgrade run proves every existing financial figure is preserved across them |
| `scripts/audit-financial-arithmetic.mjs`, `scripts/check-database-security.mjs` | must stay green; the baseline gains the new RPCs |

---

## 11. Delivery plan

Logically separated commits, in the migration order of §6, each with its tests
passing before the next begins:

1. agent-line identity and audit · 2. line administration functions ·
3. commission source · 4. commission payout · 5. float purchase sources ·
6. float sales · 7. line transfers · 8. commission reconciliation ·
9. views and registers · 10. permissions and `transacted_at` ·
11. data readers and server actions · 12. screens and forms ·
13. browser tests · 14. delivery report.

The final report will list changed files, the migration sequence, test results,
unresolved decisions and the PR link, as the brief requires.

---

## 12. Release boundaries honoured

No merge. No production deployment or migration. No change to hosted financial
records. No demonstration data deleted. No provider activated — and the design
deliberately keeps all five live-readiness conditions except the rate
requirement, so MTN and Airtel still cannot post until their terms and
ceilings are approved. Policy 2.0 not published. No release gate changed or
weakened. Agent Banking posting behaviour untouched, and the `cash_payable`
providers are not in this workstream's scope.

**Awaiting review of this design, and answers to §9, before any migration or
implementation code is written.**
