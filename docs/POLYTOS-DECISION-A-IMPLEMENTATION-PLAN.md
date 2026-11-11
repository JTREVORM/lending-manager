# POLYTOS — Decision A Implementation Plan

**Status:** finalized for the technical review gate. **Not authorized for development.**
**Type:** documentation only. No migration, no application code, no test change.
**Branch point:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214 migrations) — see §10.1.
**Inputs:** `docs/POLYTOS-DECISION-A-GAP-ANALYSIS.md`; PR #25 (`20261112000100`,
`20261109000100`) and `docs/POLYTOS-SHARED-TILL-CLOSURE-REPORT.md`; the Phase 4A–4E
stack (PRs #22–#27); the Phase 10/11 ledger.
**Companion:** `docs/POLYTOS-DECISION-A-TECHNICAL-REVIEW.md` — the review findings
that shaped this plan, and the changes recommended before authorization.
**Production:** NO-GO. Draft PRs #26 and #27 untouched.

---

## 1. The approved decision set, as applied

The Product Owner has approved A-1 through A-13. They answer, in order, the
thirteen open questions in `POLYTOS-DECISION-A-GAP-ANALYSIS.md` §9. The rulings
below are what this plan implements.

| ID | Question (gap analysis §9) | Ruling applied | Confidence |
| --- | --- | --- | --- |
| **A-1** | Scope and actor of physical-cash confirmation | **Independent receipt verification** — a receipt is confirmed by somebody other than the person who took it | Stated in brief |
| **A-2** | Does sufficiency apply beyond the three named payout paths | **Universal** — every outgoing financial path | Stated in brief |
| **A-3** | Are MTN/Airtel inflows pending until reconciled | *Assumed:* wallet inflows follow the physical-cash confirmation rule, not the bank-clearance rule | **CONFIRM** |
| **A-4** | May `allow_negative_cash` override availability | *Assumed:* **no** — availability is not governed by that flag | **CONFIRM** |
| **A-5** | Per account, or per branch aggregate | *Assumed:* **per account** (rules 2 and 3) | **CONFIRM** |
| **A-6** | Clearance dating and back-dating window | *Assumed:* `cleared_on` is the bank value date, `>= deposit_date`, no posting into a closed period | **CONFIRM** |
| **A-7** | Partial clearance | **Full clearance only** — a deposit clears for its whole amount or not at all | Inferred from "full bank clearance" |
| **A-8** | A deposit the bank refuses | **Bounced-deposit investigation** — an explicit state with a decided outcome | Stated in brief |
| **A-9** | Who may reverse a verified clearance | **Owner only, with separation of duties** | Stated in brief |
| **A-10** | What a pending receipt stops counting for | **Nothing in the loan book** — no double-posting of loan repayments | Stated in brief |
| **A-11** | Should refusals be recorded | **Yes — nonfinancial refusal-audit logging that cannot bypass financial controls** | Stated in brief |
| **A-12** | Branch-scoped ledger reads | **In scope** — branch-scoped finance access, with Head Office branch selection | Stated in brief |
| **A-13** | Vocabulary | **Cash in Transit**; `cleared` stays the loan word | Inferred |

Four rulings (A-3, A-4, A-5, A-6) are not named in the review brief and are
carried here as stated assumptions. Each is flagged at the point of use. §15
lists them for confirmation.

---

## 2. What changes, and what must not

### 2.1 The three things this plan does not touch

1. **The double entry.** No account is renamed, no posting direction reverses,
   no existing journal line moves. Availability is a restriction on an asset or
   a different account to hold it in — never a second set of books.
2. **`loan_payments` and its guard.** `loan_payments_guard_mutation`
   (`20261006000500`) permits exactly one transition, `posted → reversed`, and
   freezes every other column against the owner and `service_role` alike. No
   confirmation status, column or transition is added to it. (§7, and review
   finding **B4**.)
3. **The certified identities.** All of them stay green, including the two that
   a new `cash_kind` would otherwise break. (§14.)

### 2.2 The shape of the solution

| Rule | Mechanism |
| --- | --- |
| Sufficient available funds (rules 1, 8) | `assert_cash_funds_available()` — lock-first, availability-aware, on **every** outgoing path (§3, §5) |
| Selected funding account (rule 1) | an explicit account argument, replacing method-implied resolution (§5.2) |
| Independent control per account (rule 2) | per-account availability; no branch aggregate; explicit account selection |
| No cross-account borrowing (rule 3) | unchanged — nothing nets; enforcement makes refusal the outcome rather than overdraft |
| Physical cash confirmed (rule 4) | `cash_receipt_confirmations` — a restriction record, one journal at receipt (§7) |
| Bank deposits cleared (rule 5) | `1050 Cash in Transit` + `bank_deposits` document (§6) |
| Clearance evidence (rule 6) | evidence columns on `bank_deposits`, required by CHECK when cleared |
| Different verifier (rule 7) | distinct-actor rule at function **and** constraint layer (§6.3) |
| Atomic, concurrency-safe (rule 9) | PR #25's `post_journal` lock + the lock-order contract (§11) |
| Refusal moves nothing (rule 10) | unchanged transaction semantics; refusal logging is post-rollback and out-of-band (§9) |
| Auditable (rule 11) | `record_audit_event` on every transition; append-only documents |

---

## 3. The complete outgoing-path inventory

A-2 is universal, so the inventory must be complete. This is every function at
the PR #27 head that **credits** a cash-kinded account, with its enforcement
status today.

| # | Function | Entry point | Credits | Sufficiency today |
| --- | --- | --- | --- | --- |
| 1 | `post_disbursement_journal` | `disburse_loan` | branch till | **none** |
| 2 | `post_savings_withdrawal` | same | branch cash by method | **none** |
| 3 | `post_benefit_payment` | same | branch cash by method | **none** |
| 4 | `post_reversal_journal` | `reverse_payment` | branch cash by original method | **none** |
| 5 | `reverse_savings_transaction` | same | the original cash account | **none** |
| 6 | `reverse_membership_fee` | same | the receiving account | **none** |
| 7 | `reverse_meeting_fine_payment` | same | the fine's cash account | **none** |
| 8 | `approve_reconciliation` (lending, shortage) | same | the counted account | **none** |
| 9 | `post_transfer_journal` | `record_transfer`, `approve_transfer` | source account | `assert_cash_available` |
| 10 | `reverse_transfer` | same | destination account | `assert_cash_available` |
| 11 | `post_expense_journal` | `record_expense`, `approve_expense` | payment account | `assert_cash_available` |
| 12 | `reverse_other_income` | same | receiving account | `assert_cash_available` |
| 13 | `post_agency_transaction` | `verify_agency_transaction` | till and/or float | cash + float asserts |
| 14 | `reverse_agency_transaction` | same | till and/or float | cash + float asserts |
| 15 | `post_agency_payable_settlement` | same | settlement account | `assert_cash_available` |
| 16 | `post_float_replenishment` | same | funding account | `assert_cash_available` |
| 17 | `approve_agency_cash_reconciliation` | same | counted till | `assert_cash_available` |
| 18 | `approve_agency_float_reconciliation` | same | float account | float assert |
| 19 | `reverse_commission_settlement` | same | settlement account | `assert_cash_available` |
| 20 | `verify_agency_float_trade` / `reverse_agency_float_trade` | same | till and float | both asserts |
| **21** | **`record_bank_deposit`** (new, §6) | new | branch till | **to add** |
| **22** | **`verify_bank_deposit`** (new, §6) | new | `1050` | **to add** |

**Paths 1–8 are the work of A-2.** Paths 4–8 are new to the inventory: PR #25
reported three unchecked cash-out paths because it enumerated the *source types
present in the seeded book*, and a membership-fee refund, a meeting-fine refund
and a lending shortage write-off were not in it. Paths 9–20 already enforce and
need only the availability upgrade (§5.1).

Path 8 is additionally inconsistent with its agency twin, which does check and
does lock (review finding **H5**).

Paths 4–7 are the **reversal family**, where enforcement and correction pull in
opposite directions. §5.3 states the resolution.

---

## 4. Workstream D1 — availability primitives

Read-only. No behaviour change: with no confirmation rows and an empty `1050`,
availability equals the booked balance for every account.

### 4.1 `cash_receipt_confirmations`

```
id                    uuid pk
journal_entry_id      uuid not null unique references journal_entries(id)
account_id            uuid not null references ledger_accounts(id)
branch_id             uuid not null references branches(id)
amount                bigint not null check (amount > 0)
state                 text not null  -- 'pending' | 'confirmed' | 'void'
source_type           text not null  -- copied from the entry, for the register
recorded_by           uuid, recorded_by_label text not null
confirmed_by          uuid, confirmed_by_label text, confirmed_at timestamptz
void_reason           text
created_at, updated_at
```

Constraints: `confirmed` requires `confirmed_by`, `confirmed_by_label` and
`confirmed_at`; `void` requires a reason; **`confirmations_verifier_not_recorder`
— `confirmed_by is null or confirmed_by <> recorded_by`** (A-1); one row per
journal entry; `reject_mutation()` on DELETE; a column guard so `amount`,
`account_id` and `journal_entry_id` are write-once.

### 4.2 Written by `post_journal`, not by each caller

A single helper, invoked from inside `post_journal` over the lines it has been
handed, creating a `pending` row for every credited… — precisely, for every
**debited** cash account whose inflow requires confirmation under A-1/A-3. One
place instead of eight, covering paths added later, which a list of call sites
cannot promise. This is PR #25's argument for putting the lock in `post_journal`,
applied to the same problem.

Which inflows require confirmation is decided by source type and method, and is
the A-1/A-3 ruling made concrete:

| Inflow | Confirmation |
| --- | --- |
| cash into a till | **pending** — A-1 |
| MTN / Airtel into a wallet | **pending** — A-3 *(assumed; §15)* |
| bank (a direct credit) | **pending** — reaches the bank account, so it is evidence-led like a deposit |
| a transfer between own accounts, a clearance, a reversal, an agency posting | **none** — the money is already inside the business and already controlled |

### 4.3 Functions and views

| Object | Shape | Notes |
| --- | --- | --- |
| `cash_account_available_balance(uuid) returns bigint` | `stable`, definer, **no lock** | booked − pending − (for a bank account, nothing; in-transit money is not in it) |
| `assert_cash_funds_available(uuid, bigint)` | `volatile`, definer | `lock_ledger_balances(array[p_account_id])` **first**, then availability, then raise. Reads its own policy column, never `allow_negative_cash` (A-4; precedent: correction C4) |
| `assert_spendable_account(uuid, text)` | `stable`, definer | refuses `in_transit`, `agency_float`, headings, inactive and non-cash accounts |
| `cash_account_availability` view | `security_invoker`, revoke-then-grant | `(account_id, branch_id, booked, pending_in, available)` |
| `confirm_cash_receipt(uuid)` / `confirm_cash_receipts(uuid[])` | definer | A-1's second actor; locks the account (§11.4); batch form for counter throughput |
| `void_cash_confirmation(uuid, text)` | definer | for a receipt reversed before confirmation |

### 4.4 Settings

`finance_settings` gains, following correction C4's precedent exactly:

- `require_cash_receipt_confirmation boolean not null default true`
- `require_bank_clearance boolean not null default true`
- `allow_negative_available boolean not null default false` — read **only** by
  `assert_cash_funds_available`, never `allow_negative_cash`, so relaxing the
  booked rule cannot relax the availability rule.

---

## 5. Workstream D2 — universal enforcement and the selected funding account

### 5.1 Enforcement

Every path in §3 calls `assert_cash_funds_available`. Paths 9–20 move from
`assert_cash_available` to it, so there is one rule rather than two.
`assert_cash_available` is retained unchanged for the booked question and for
`1050` (where availability and booked are the same thing by construction).

### 5.2 The selected funding account

`payment_method` does not identify an account. `branch_cash_account(branch, kind)`
resolves `order by code limit 1`, and the partial unique index deliberately
permits **several bank accounts per branch** — so `payment_method = 'bank'`
silently picks the alphabetically lowest-coded one. That is unmet rule 1 *and*
unmet rule 2, on the withdrawal and benefit paths as much as the disbursement
path (review finding **H1**).

So all three gain an explicit account argument:

| Function | Change |
| --- | --- |
| `disburse_loan(p_loan_id)` | → `disburse_loan(p_loan_id, p_funding_account_id, p_branch_id default null)` |
| `post_savings_withdrawal(p_request_id, p_payment_method, p_external_reference, p_idempotency_key)` | → adds `p_funding_account_id` |
| `post_benefit_payment(p_claim_id, p_payment_method, p_external_reference, p_idempotency_key)` | → adds `p_funding_account_id` |

Validation on each: the account exists, is active and postable,
`assert_spendable_account`, belongs to the branch the document belongs to, is
visible under `user_can_see_branch`, and — where a method is also given — its
`cash_kind` agrees with `payment_method_cash_kind(p_payment_method)`, so the
receipt a member is handed cannot say "bank" over a till payment.

**Signature changes DROP then CREATE. They never add a defaulted parameter.**
A defaulted parameter creates an overload and PostgreSQL then refuses every call
as ambiguous — the reason recorded in `20261115001500` and `20261115000500`,
which both dropped and recreated for exactly this. There are **no internal
database callers** of the three, so the blast radius is `lib/loans/actions.ts`,
`lib/savings/actions.ts`, `lib/benefits/actions.ts`, `types/database.types.ts`
and the ADR-070 column test. Each DROP is followed by its `revoke`/`grant` pair
in the same migration.

### 5.3 The reversal family — enforcement versus correction

Paths 4–7 credit cash for two different reasons, and A-2 cannot treat them
identically without breaking one of them:

- a **refund** — money genuinely leaves the business; sufficiency must apply;
- a **correction** — the original credit was wrong, so the money was never
  there; refusing the contra entry would leave the books permanently wrong.

The existing precedent is that reversals *do* check: `reverse_transfer`,
`reverse_other_income` and `reverse_agency_transaction` all assert on the
account that must give the money up. This plan follows it, and adds the escape
hatch rather than leaving five paths unchecked:

1. All eight paths enforce by default.
2. A **correction override** — `p_correction_override boolean default false`
   plus a mandatory reason — is accepted on paths 4–7 only. It requires
   `finance:correction` (Owner only), is recorded in `audit_log` with the
   reason and the resulting balance, and raises a notification.
3. It is **refused outright** on paths 1–3 and 21–22, where no correction
   semantics exist: a disbursement, a withdrawal, a benefit payment and a
   deposit either have the money or do not.
4. Path 8 (shortage write-off) needs no override: after the write-off the
   account equals the physical count, which `counted_balance >= 0` already
   guarantees non-negative. It gains the assert as a staleness guard, matching
   its agency twin.

---

## 6. Workstream D3 — Cash in Transit, bank clearance, bounced deposits

### 6.1 `1050 Cash in Transit`, and the three things that must ship with it

One row per branch, `cash_kind = 'in_transit'`, asset, debit normal side.
Adding a sixth `cash_kind` has three inseparable consequences, all of which
happened verbatim when Phase 4A added the fifth (`20261107000900` header):

1. **`branch_cash_position` gains an `in_transit` component, in the same
   migration.** `total_liquidity` is `sum(balance) where cash_kind is not null`,
   so a sixth kind that is not also a named component makes the parts stop
   summing to the total — and two certified identities,
   `hand + bank + mtn + airtel + agency float = total_liquidity` and
   `total_liquidity = GL accounts with a cash_kind`, plus three test suites, fail.
   **In-transit money stays inside `total_liquidity`**: it is an asset the
   business holds. What must exclude it is *available* funds, which is a
   different figure in its own columns. (This corrects gap analysis D12 — review
   finding **B2**.)
2. **`assert_cash_account` is hardened to refuse `in_transit`, in the same
   migration.** That function tests only `cash_kind is null`, so the moment the
   kind is legal, a `transfers:create` holder — which `secretary_treasurer` holds
   — can `record_transfer` money straight out of Cash in Transit into a bank
   account: no clearance, no verifier, no evidence, no Owner, and under
   `allow_negative_cash`. The entire maker-checker would be bypassable by the
   module it is meant to control. This is precisely the bypass Phase 4A closed
   for `agency_float` in the migration that created it, and the two are
   inseparable here for the same reason. (Review finding **B3**.)
3. **One `in_transit` account per branch** is added to
   `ledger_accounts_one_wallet_per_branch` (or its own partial unique index), or
   `branch_cash_account(branch, 'in_transit')` repeats the arbitrary-pick defect
   of §5.2.

`scripts/certify-financial-reconciliation.mjs` must gain the component in its
sum identity. That is a change to a certification script and therefore belongs
to the implementation phase, not to this review.

### 6.2 `bank_deposits`

```
id, deposit_number                 -- next_reference('bank_deposit')
branch_id, from_account_id         -- the till
transit_account_id                 -- 1050 for that branch
bank_account_id                    -- cash_kind = 'bank', same branch
amount                             -- > 0
deposit_date                       -- business_date()
status                             -- 'submitted' | 'cleared' | 'rejected'
                                   -- | 'under_investigation' | 'written_off' | 'reversed'
bank_reference, cleared_on, deposit_slip_path, clearance_notes
investigation_opened_at, investigation_opened_by, investigation_reason
investigation_outcome, investigation_closed_at, investigation_closed_by
recorded_by / _label
verified_by / _label / verified_at
decision_reason
deposit_journal_entry_id    uuid unique   -- till -> 1050, at recording
clearance_journal_entry_id  uuid unique   -- 1050 -> bank, at verification
reversal_entry_id           uuid unique
idempotency_key             uuid not null unique
created_at, updated_at
```

Constraints: amount positive; the three accounts distinct and in the same
branch; `(status <> 'rejected') = (deposit_journal_entry_id is not null)`;
`(status = 'cleared') = (clearance_journal_entry_id is not null)`;
**`bank_deposits_verifier_not_recorder`** — `verified_by is null or verified_by
<> recorded_by`; when `cleared`, `bank_reference` non-blank and `cleared_on`,
`verified_by`, `verified_at` all present; `cleared_on >= deposit_date` (A-6);
rejection, investigation and reversal each require a reason;
`reject_mutation()` on DELETE and a column guard making the evidence write-once.

### 6.3 The functions

| Function | Capability | Behaviour |
| --- | --- | --- |
| `record_bank_deposit(from_account, bank_account, amount, deposit_date, description, idempotency_key, branch_id default null)` | `deposits:create` | advisory lock on the key, replay returns the row; branch per §8; `assert_cash_funds_available(till, amount)` — **a deposit is an outgoing path** (§3 path 21); posts Dr `1050` / Cr till; `submitted` |
| `verify_bank_deposit(deposit_id, bank_reference, cleared_on, slip_path, notes)` | `deposits:verify` | `for update`; idempotent if already `cleared`; **refuses `recorded_by = current_profile_id()` with `42501`**; `user_can_see_branch`; evidence validated; `assert_cash_available(transit, amount)`; **full amount only** (A-7); posts Dr bank / Cr `1050`; `cleared` |
| `reject_bank_deposit(deposit_id, reason)` | `deposits:verify` | only from `submitted`; distinct-actor; contra of the deposit entry; money returns to the till; `rejected` |
| `open_deposit_investigation(deposit_id, reason)` | `deposits:verify` | from `submitted` or `cleared`; **posts nothing** — the money stays where it is while the question is open (A-8) |
| `close_deposit_investigation(deposit_id, outcome, reason, …)` | `deposits:verify` | three outcomes, §6.4 |
| `reverse_bank_deposit_clearance(deposit_id, reason)` | **`deposits:reverse` — Owner only** | only from `cleared`; `assert_cash_available(bank, amount)` — the bank must still hold it, as `reverse_transfer` already requires; **refuses the person who verified it** (A-9); contra of the *clearance* entry only, returning the money to `1050`; status back to `submitted` with the evidence columns cleared and preserved in audit; stamps `reversed_by_entry_id` |

**A-9 needs both halves.** "Owner only" is a capability granted to
`owner_admin` alone. "With separation of duties" is a *row-level* rule, because
an Owner holds `deposits:verify` as well and could otherwise verify a deposit
and then reverse their own verification. Both are enforced, and the
verifier-reversal refusal is also a CHECK-backed column pair so it cannot be
forgotten.

### 6.4 Bounced-deposit outcomes (A-8)

An investigation holds the money in `1050` and posts nothing until it closes.
Three outcomes, three different postings:

| Outcome | Posting | Status |
| --- | --- | --- |
| `recovered` | the normal clearance, Dr bank / Cr `1050`, with evidence | `cleared` |
| `returned_to_till` | contra of the deposit entry, Dr till / Cr `1050` | `rejected` |
| `written_off` | Dr a loss account / Cr `1050` | `written_off` |

The write-off needs a chart decision. `5950 Cash Over and Short` is for count
variances and reusing it would merge two different facts in one account — the
error `4340` exists to avoid. **This plan adds `5960 Deposit Losses Under
Investigation`** under the `5000` heading. Writing off requires `deposits:reverse`
(Owner) and a reason, and is reported separately.

---

## 7. Workstream D4 — receipt confirmation without double-posting

A-10 is the constraint that decides the design. Three options were considered;
only one survives the schema.

| Option | Verdict |
| --- | --- |
| Post the journal at **verification** instead of receipt (the `verify_agency_transaction` model) | **Refused.** `loan_payments.status` would have to carry a third value, which `loan_payments_guard_mutation` refuses outright (it permits only `posted → reversed`); and `loan_balances`, `loan_installment_coverage` and `payment_collection_totals` all filter `status = 'posted'`, so every borrower's arrears, delinquency state, installment coverage and loan clearance would change. The borrower paid; their balance must not move because the business has not yet counted its drawer |
| Post to a **holding account** at receipt and transfer to the till on confirmation | **Refused.** Two journals per receipt — the double-posting A-10 forbids — and it misstates where the cash physically is, so the daily count would stop agreeing with the till |
| **One journal at receipt, plus a restriction record** | **Adopted.** §4.1 |

So: `post_payment`, `post_savings_deposit`, `record_membership_fee`,
`post_meeting_fine_payment` and `record_other_income` are **unchanged**. Each
still writes exactly one journal, at receipt, debiting the real cash account.
`post_journal` additionally writes a `pending` confirmation row (§4.2), which
deducts from availability and from nothing else.

What this preserves, and what each test must assert:

- one journal per receipt — `journal_entries_one_per_source` unchanged;
- `loan_payments.status = 'posted'` at receipt, so every balance view, arrears
  figure, delinquency state and loan clearance is **bit-identical** to today;
- the `1200` ↔ `principal_outstanding`, `4100` ↔ interest collected and
  `2100` ↔ `sum(signed_amount)` identities unchanged;
- `loan_payments_guard_mutation` and `payment_allocations`' no-update rule
  untouched.

Confirmation is the second actor's act (A-1): `confirm_cash_receipt` refuses the
recorder at the function layer and at the constraint layer, locks the account,
and records both names. A receipt reversed before confirmation voids its
pending row rather than leaving a deduction against money that is no longer
booked.

---

## 8. Workstream D5 — branch-scoped finance access and Head Office selection

### 8.1 Reuse the operating-branch rule; do not write a second one

PR #27's `20261115001500_agency_operating_branch.sql` already settles this, and
records why guessing is worse than refusing: `create_agency_transaction` fell
back to *the alphabetically first active branch*, which was right by accident
while there was one branch and routed five counter tests to the wrong till the
moment there were two. Head Office is exactly the affected officer — the Owner
and the Secretary both carry `profiles.branch_id = null`.

The approved rule, which Decision A calls rather than re-derives:

> a branch-less officer names the operating branch, a branch-assigned officer
> records at their own and may name no other, the branch is validated against
> what the officer may see, and it must be open.

`disburse_loan`, `record_bank_deposit` and the confirmation functions take
`p_branch_id uuid default null` **last**, so every positional call by a
branch-assigned officer stays valid — the reason that migration gives for the
same choice. **This makes PR #27 a hard dependency of Decision A** (§10.1).

### 8.2 Close the two branch gaps (A-12)

- **Write paths.** `user_can_see_branch` is added to `record_transfer`,
  `approve_transfer`, `reject_transfer`, `reverse_transfer`, the three expense
  functions, `record_other_income`, `reverse_other_income`,
  `submit_reconciliation`, `approve_reconciliation`, `disburse_loan`,
  `post_payment` and `reverse_payment`. Rules 2 and 3 are not enforceable while
  a `transfers:create` holder can move another branch's cash.
- **Read policies.** A branch predicate is added to the `journal_entries`,
  `journal_lines` and `ledger_accounts` select policies, which today have none,
  so any `ledger:view` holder reads every branch's journals and cash accounts.
  Every `profiles.branch_id` is currently null — unrestricted — so **the
  observable blast radius is nil today and grows with the first branch
  assignment.** This is the cheapest moment it will ever have.

### 8.3 Capabilities

| Capability | `secretary_treasurer` | `manager` | `owner_admin` |
| --- | --- | --- | --- |
| `deposits:view` | ✓ | ✓ | ✓ |
| `deposits:create` | ✓ | ✓ | ✓ |
| `deposits:verify` | | ✓ | ✓ |
| `deposits:reverse` | | | ✓ |
| `receipts:confirm` | | ✓ | ✓ |
| `finance:correction` | | | ✓ |

The distinct-actor rules do the real work: `manager` and `owner_admin`
necessarily hold both sides of several pairs, and the schema already records
that approving and paying a withdrawal *may* deliberately be the same person.
A capability split alone would be theatre.

---

## 9. Workstream D6 — nonfinancial refusal-audit logging

### 9.1 It cannot be done inside the database

Rule 10 requires a refused payout to move nothing, which it achieves by
aborting the transaction — and that abort takes any log row with it. An
autonomous transaction would be the in-database answer, and this deployment has
no mechanism for one: the only installed extension is `pg_trgm`. There is no
`dblink`, no `pg_background`, no `pg_cron`. (Review finding **B5**.)

### 9.2 The design

A **post-rollback, application-layer, best-effort** write:

1. The server action calls the payout RPC. It fails.
2. The action catches the failure and calls `log_refused_financial_action(...)`
   on a **new** transaction, with the classification, the document, the account,
   the requested amount, the SQLSTATE and the actor's own session.
3. The row lands in `refused_financial_actions`. The refusal itself already
   stands, whatever happens in step 3.

### 9.3 The four properties that make it unable to bypass financial controls

1. **It can write nothing financial.** `log_refused_financial_action` is
   `SECURITY DEFINER` over one table, is granted `execute` to `authenticated`
   alone, and is granted nothing on `journal_entries`, `journal_lines` or any
   document table. It has no `post_journal` call and no status write.
2. **Its output is never an input.** No authorization, sufficiency, approval or
   clearance decision reads `refused_financial_actions`. A refusal cannot be
   logged and then cited to obtain an override; the correction override of §5.3
   is a separate, Owner-gated argument on the posting function itself.
3. **Logging failure is not success.** The action returns the refusal to the
   user whether or not the log write succeeded. A logging outage degrades
   evidence, never control.
4. **It is not a side channel.** The actor is derived from the session, never a
   parameter; the table carries no foreign key that could be probed for the
   existence of rows the caller may not read; `select` is gated on a new
   `audit:view_refusals` capability; and writes are rate-limited per actor
   through the existing `rate_limit_counters`, so it cannot be used to flood the
   table or to enumerate accounts by watching which calls are accepted.

The table is append-only (`reject_mutation()` on UPDATE and DELETE) with a
register view, and carries no amount that could be mistaken for a posting — it
records the *request*, which is why the deliverable is named nonfinancial.

---

## 10. Migration order and safety

### 10.1 Branch point

| Candidate | Verdict |
| --- | --- |
| Audited base `64ea09c` (161) | **No.** No `lock_ledger_balances`, no `post_journal` lock; enforcement here reintroduces the TOCTOU race |
| PR #25 head (194) | **No.** Has the locking, but not the operating-branch rule A-12/§8.1 depends on |
| **PR #27 head (214)** | **Yes.** Carries the locking *and* the operating-branch rule |

Decision A's migrations are dated **after `20261115001600`**, so the stack is
never re-ordered.

**Conflict analysis.** PRs #26 and #27 redefine **none** of `post_journal`,
`assert_cash_available`, `lock_ledger_balances`, `disburse_loan`, `post_payment`,
`post_reversal_journal`, `post_savings_withdrawal` or `post_benefit_payment`, so
Decision A's changes to those are conflict-free against both. `branch_cash_position`
was last redefined by `20261107000900` (the #22/#23 lineage); Decision A extends
**that** version, not the Phase 11 one.

### 10.2 Order, and why

| Step | Migration | Must precede |
| --- | --- | --- |
| 1 | `cash_receipt_confirmations`, settings columns, availability functions and view | everything |
| 2 | `in_transit` kind **+** `branch_cash_position` component **+** `assert_cash_account` hardening **+** the uniqueness index — **one migration, indivisible** | any `1050` row |
| 3 | `1050` chart rows per branch, idempotently, and for branches created later | the deposit document |
| 4 | `5960`, the four new `source_type` values, the `bank_deposit` reference scope, the new capabilities | the deposit functions |
| 5 | `bank_deposits` + its six functions | the UI |
| 6 | `assert_cash_funds_available` wired into paths 1–8, with the DROP/CREATE signature changes | the UI |
| 7 | paths 9–20 moved onto the availability assert | — |
| 8 | branch predicates on the write paths and the ledger read policies | — |
| 9 | `refused_financial_actions` + its RPC | the server actions |

Step 2 is indivisible for the reason Phase 4A gave about `agency_float`: either
half without the other is a defect — one breaks the certified identities, the
other opens a bypass of the control being built.

### 10.3 Historical accounting is preserved by construction

Both halves of the design are built so that **the absence of a record means
available**:

- no historical inflow has a confirmation row, so none is deducted;
- `1050` opens at zero and is only ever credited by clearances of deposits
  recorded after the cutover.

So at cutover **every existing balance is available in full: no row is written,
no journal is posted, no figure moves.** That is a property of the design, not a
promise about a script, and it is what satisfies the prohibition on accidental
changes to historical balances. A backfill of confirmation rows, or re-posting
historical deposits through `1050`, is refused.

Specifically protected: the derived opening entry of **21,449,163** and the
assertion that Cash at Hand touches exactly zero at its lowest historical point;
`journal_entries_guard_update`, which is why clearance state lives on its own
table rather than on the entry; and every existing migration, which is neither
edited, renamed nor re-ordered.

### 10.4 Mechanics

`ledger_accounts_cash_kind_valid` and `journal_entries_source_valid` are widened
by drop-and-recreate, repeating the existing values verbatim — and **their live
names are queried before the DDL is written**, because Phase 4A found the
architecture specification had both constraint names wrong and would have
aborted if transcribed. New columns are registered in
`tests/db/postgrest-columns.test.ts` (ADR-070) and types regenerated with
`npm run db:types`. **No feature flag for the rules themselves**: §10.3 makes the
transition a no-op, so a flag would buy nothing and is how the controls would
come to be silently switched off. The three settings columns of §4.4 are the
named, audited, Owner-only rollback levers.

**No migration is applied to production.** The release gates' existing blockers
— including the Git-linked Supabase branch reporting `MIGRATIONS_FAILED` — are
independent of this work and clear on their own terms.

---

## 11. Concurrency and the lock-order contract

1. **The global order is unchanged:** provider lock → account locks (sorted) →
   reference counter. Every new path acquires account locks only through
   `lock_ledger_balances`, which sorts, de-duplicates and drops nulls.
2. **Availability is computed under the lock, after it** — the construction
   `20261109000100` chose, so a waiting transaction sees the committed result of
   the one it waited for.
3. **Multi-account postings lock up front, together.** A clearance touches
   `1050` and the bank account; an investigation close may touch `1050` and the
   till. Both are locked before the sufficiency check, in sorted order, because
   PR #25's transfer fix showed that holding an out-of-order *subset* is exactly
   what deadlocks once `post_journal` locks the whole entry.
4. **Confirmation locks the account it makes available.** Otherwise a payout can
   be decided against a stale availability read.
5. **Nothing is cached.** Availability is derived on every read (ADR-052), so a
   reversal changes every availability figure the instant it commits.
6. **Idempotency on every new write path:** `idempotency_key uuid not null
   unique`, advisory lock on the key taken first, authorization **above** the
   replay shortcut (ADR-056), and verification idempotent on an already-cleared
   deposit.

---

## 12. Test plan

### 12.1 PostgreSQL (`tests/db/`, `vitest --project db`)

**`cash-sufficiency.test.ts`** — a case per path, **all eight**, not three:
each refused when the funding account is short; each refusal writing no journal,
no line, no document, no status change and no balance movement; each refused
when booked is sufficient but available is not; each permitted once confirmed or
cleared; `1050` refused as a funding account on every path; a cross-branch
funding account refused; `allow_negative_cash` **not** relaxing availability
(A-4); the correction override accepted on paths 4–7 with Owner and reason,
refused without them, and refused outright on paths 1–3 and 21–22.

**`cash-sufficiency-concurrency.test.ts`** — real parallel connections,
extending PR #25's harness: two disbursements each affordable alone; disbursement
versus withdrawal; disbursement versus benefit; benefit versus withdrawal;
payment reversal versus disbursement; a payout racing a clearance; a payout
racing a confirmation; two verifications of one deposit; and the lock-order
deadlock probe over `1050` + bank in opposing orders. Each test holds **only**
the account's advisory lock, posts nothing, takes no reference, and distinguishes
*refused* from *walked past* — because `next_reference('journal')` serialises
every posting until commit and makes outcome-based races pass by accident.

**`bank-clearance.test.ts`** — evidence required; `cleared_on` before
`deposit_date` refused; partial clearance refused (A-7); verifier ≠ recorder
refused by the function **and** by direct `UPDATE` as `service_role`; double
clearance refused by `journal_entries_one_per_source`; clearance reversal
Owner-only, refused for the verifier, returning money to `1050`, refused when the
bank no longer holds it; rejection only from `submitted`; **a transfer out of
`1050` refused** (the §6.1.2 bypass); idempotent replay of both functions.

**`deposit-investigation.test.ts`** — opening posts nothing; each of the three
outcomes posts exactly its own entry; an outcome from the wrong state refused;
the write-off requiring Owner and a reason and landing in `5960`.

**`cash-availability.test.ts`** — `available = booked − pending`; a pending
inflow does not raise availability; reversing a pending receipt voids its
deduction; **no confirmation row ⇒ fully available**, asserted against the demo
book; the view and the function agreeing account by account; in-transit money
inside `total_liquidity` and outside available.

**`receipt-confirmation.test.ts`** — the A-10 regression suite: after a receipt,
`loan_payments.status = 'posted'`, exactly one journal exists, and
`loan_balances`, `loan_installment_coverage`, `payment_collection_totals`,
arrears, delinquency state and loan clearance are **identical to the pre-change
figures**; confirmation adds no journal; confirmer ≠ recorder enforced at both
layers; batch confirmation atomic.

**`rls-deposits.test.ts`** — `anon` denied on every new table and view; no
INSERT/UPDATE/DELETE grant; a branch-scoped profile sees only its branch; the
new ledger branch predicate enforced; `refused_financial_actions` readable only
with `audit:view_refusals`.

**`refusal-audit.test.ts`** — a refused payout leaves a log row and **no**
financial row; the RPC cannot write a journal; a logging failure still refuses;
the log is append-only; rate limiting applies.

**Identity and regression** — `trial_balance` foots; `1050` equals the sum of
submitted and under-investigation deposits; the `1200`, `4100`, `2100`
identities hold; the opening entry is still 21,449,163 and the till still touches
zero; **every existing suite passes unchanged**, which is the evidence that this
is additive.

### 12.2 Integration (`vitest --project integration`)

Friendly refusal messages, never a raw SQLSTATE; the funding-account and branch
arguments validated and safely rejected when absent, malformed or invisible;
rate limiting intact on disbursement; `revalidatePath` covering the finance,
loan, savings and benefit routes a clearance changes; the refusal-log call fired
on failure and swallowed on its own failure; `audit:money` over any new money
TypeScript.

### 12.3 Browser (Playwright, `tests/e2e/specs/`)

`bank-deposits.write.spec.ts` — record, see it excluded from available funds,
verify as a **second** user, see the first user's verify attempt refused, and an
Owner-only reversal refused for the verifier. `cash-sufficiency.write.spec.ts` —
the funding-account picker showing **available** balances per account (not one
aggregated bank figure), submit blocked when short, server refusing when the
form is bypassed; the same on the withdrawal and benefit screens. A Head Office
officer prompted to name the operating branch; a branch-assigned officer not
offered another. `receipt-confirmation.write.spec.ts` — a receipt visible as
unconfirmed, confirmable only by a second user. Plus: no screen presenting
aggregated liquidity as spendable; no partial state after a refusal and reload;
an `@axe-core/playwright` pass on every new screen.

### 12.4 Certification

`npm run verify`, `npm run test:db`, `npm run audit:money`, the database
security gate, `scripts/certify-financial-reconciliation.mjs`
**with its sum identity extended for `in_transit`**, the historical migration
replay with identical figures, and the new-head required CI.

---

## 13. Phases and release dependencies

| Phase | Workstream | Depends on | Characteristic |
| --- | --- | --- | --- |
| **A-I** | D1 — availability primitives, no enforcement | PR #27 | **Zero behaviour change** |
| **A-II** | D3 step 2–4 — `in_transit`, the view component, the `assert_cash_account` hardening, the chart | A-I | Zero behaviour change; indivisible |
| **A-III** | D2 — universal enforcement, all eight paths, explicit funding accounts | A-I, A-II | First behaviour change; closes the escalated finding |
| **A-IV** | D3 step 5 — deposits, clearance, investigations | A-II, A-III | Closes rules 5, 6, 7 |
| **A-V** | D4 — receipt confirmation | A-I, A-III | Closes rules 4, 8. **Highest operational impact** |
| **A-VI** | D5 — branch scoping and Head Office selection | A-III | Nil blast radius today |
| **A-VII** | D6 — refusal audit | A-III | Nonfinancial |
| **A-VIII** | Reporting and UI: booked / in transit / available, ageing, the form hints | A-I…A-VII | Read-only |
| **A-IX** | Certification and release-gate update | all | **Production stays NO-GO** |

A-III early rather than late, because it closes the live overdraft; A-IV and A-V
after it, because a payout refusal without a clearance workflow is inconvenient
but financially safe, whereas a clearance workflow without enforcement is
paperwork that stops nothing. Each phase is its own PR, stacked, and none is
merged under the current gates.

---

## 14. The invariant register

Every item must hold after every phase, and each has a named assertion.

| Invariant | Where asserted |
| --- | --- |
| Every journal balances; every entry has ≥ 2 lines | deferred constraint triggers |
| One journal per `(source_type, source_id)` | `journal_entries_one_per_source` |
| The ledger is append-only; one mutable column on an entry | `journal_lines` triggers, `journal_entries_guard_update` |
| `trial_balance` foots; it equals the journal | certification identities |
| `total_liquidity` = sum of its **six** named components | certification identity, **to extend** |
| `total_liquidity` = every GL account with a `cash_kind` | certification identity |
| `1200` = `principal_outstanding` | certification identity |
| `2100` = `sum(signed_amount)` over `savings_transactions` | savings suites |
| `4100` = interest actually collected | certification identity |
| Loan balances, arrears and delinquency unchanged by confirmation | `receipt-confirmation.test.ts` (new) |
| `loan_payments` admits exactly one status transition | `loan_payments_guard_mutation` |
| Opening entry = 21,449,163; till touches zero | ledger suite |
| A refused payout writes nothing financial | `cash-sufficiency.test.ts` (new) |
| No account with a `cash_kind` is reachable by a generic transfer unless spendable | `assert_cash_account`, `bank-clearance.test.ts` (new) |
| Availability is derived, never stored | code review + ADR-052 |

---

## 15. Open confirmations before authorization

1. **A-3** — do MTN and Airtel inflows require confirmation (this plan assumes
   yes, on the physical-cash rule)?
2. **A-4** — confirm `allow_negative_cash` may **not** relax availability, and
   that `allow_negative_available` is a separate Owner-only column.
3. **A-5** — confirm per-account only, with no branch aggregate rule.
4. **A-6** — confirm `cleared_on >= deposit_date`, and state the maximum
   back-dating window and whether a closed period may be posted into.
5. **§5.3** — confirm the correction override for paths 4–7: Owner capability,
   mandatory reason, audited, refused on genuine payouts.
6. **§6.4** — confirm `5960 Deposit Losses Under Investigation` as a new
   account rather than reusing `5900` or `5950`.
7. **§8.2** — confirm the ledger read policies are in scope (A-12), since this
   is the cheapest moment to close them.
8. **§5.2** — confirm explicit funding accounts on the withdrawal and benefit
   paths, not only disbursement, given that `payment_method = 'bank'` currently
   picks a bank account by code order.
9. **New ADRs** — this plan implies four, from ADR-072: availability as a
   restriction rather than a second ledger; Cash in Transit for bank deposits
   and why not for till cash; confirmation off the receipt row; refusal audit
   outside the financial transaction. The first supersedes the settlement-status
   note at the head of `20261020000400`.
