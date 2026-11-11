# POLYTOS — Decision A Implementation Plan

**Revision:** v3, reconciled line by line against the Product Owner's review
package and incorporating the booking-error correction ruling of 2026-11-11.
Supersedes v2 (`30bc027`) and v1 (`38a7e3d`).
**Status:** awaiting development authorization. **Not authorized.**
**Type:** documentation only. No migration, application code, test, financial
record, deployment configuration or PR branch touched.
**Branch point:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214 migrations) — §11.1.
**Inputs reconciled:** `POLYTOS_DECISION_A_IMPLEMENTATION_PLAN_REVIEW.md` and
`POLYTOS_DECISION_A_REVIEW_RESPONSE_v2.md` (Product Owner package, received
2026-11-11); `docs/POLYTOS-DECISION-A-GAP-ANALYSIS.md` (`4739d0d`).
**Companion:** `docs/POLYTOS-DECISION-A-TECHNICAL-REVIEW.md` v3, which carries the
clause-by-clause comparison.
**Production:** NO-GO. Draft PRs #25, #26 and #27 untouched.

---

## 1. The approved decision set

A-1 through A-13 are **approved product policy**, not assumptions. The wording
below is the Product Owner's.

| ID | Approved ruling |
| --- | --- |
| **A-1** | A cash receipt is posted for its underlying business purpose, but its **proceeds are restricted until verified per receipt** by a different authorized Manager/Owner. Secure batch verification is permitted, performing every per-receipt check |
| **A-2** | Sufficient available funds apply **universally** to every outgoing path: loans, withdrawals, benefits, transfers, expenses, genuine refunds, Agency Banking, Mobile Money, float movements and reversals. Financial-correction exceptions are not automatically authorized |
| **A-3** | Incoming MTN/Airtel electronic float becomes spendable **after a provider-confirmed transaction has been independently verified and posted**. Daily reconciliation is mandatory but does not delay already-verified float. **No second physical-cash confirmation is added to electronic float itself** |
| **A-4** | **Strict, no-override** sufficient-available-funds, including Owner/Admin. `allow_negative_cash` does not bypass it, and no `allow_negative_available` or other mutable bypass may exist |
| **A-5** | Sufficiency is strictly **per individual account**. A branch's total cash or liquidity cannot fund an account-specific shortage |
| **A-6** | `bank_value_date` is bank-evidenced, may precede verification and **may fall in a closed reporting period**; it must be on or after the deposit date. **Verification and journal posting use their actual current date and never backdate into a closed period.** No arbitrary maximum backdating window is invented |
| **A-7** | **Full clearance only** in v1. A confirmed short credit blocks all clearance and is investigated. **No automatic variance or loss journal, and no automatic use of `5950`** |
| **A-8** | A bounced deposit **remains in non-spendable Cash in Transit** during investigation. Cash returns to the till **only after independently verified physical receipt**. Missing funds receive separately authorized treatment; no auto write-off |
| **A-9** | A Manager **may request** a clearance reversal. **Owner/Admin alone authorizes and executes**, and must differ from the original verifier. Evidence, audit trail, **sufficient available funds in the source bank** and an atomic contra entry are required; otherwise block and escalate |
| **A-10** | A borrower's cash repayment **counts immediately** for amount due, arrears and deadline when recorded, while the cash remains unavailable to the company until independently confirmed. Confirmation must never post the repayment twice; disputes are investigated separately |
| **A-11** | Insufficient-funds refusals are recorded in a **secure, separate, nonfinancial log** with the minimum necessary actor, branch, account, amount, type, reason and time. A logging failure can never turn a refusal into a success. **Fail closed** |
| **A-12** | Financial **reads and writes** are branch-scoped. Owner/Admin see all. Head Office users select an **expressly authorized operating branch**; no alphabetical or `NULL ⇒ all branches` fallback for ordinary users. Cross-branch movements need both-branch authorization, without leaking inaccessible journal data |
| **A-13** | Context-specific vocabulary: cash `Pending Confirmation` / `Confirmed`; deposits `Submitted` / `In Transit`, `Cleared`, `Rejected` / `Under Investigation`, `Reversed`. `Cleared` is valid for **both** bank deposits and fully repaid loans, in distinct schema and status domains |

### 1.2 The booking-error correction ruling (2026-11-11)

This is the **fresh explicit Owner approval** that the review response demanded
at its Gate P3, and it supersedes P3's requirement that an error-correction
design create no negative balance.

> A proven booking-error correction **may create a temporary negative booked cash
> balance**, but only under all of the following conditions.

| # | Condition | Where implemented |
| --- | --- | --- |
| C1 | The original receipt was incorrectly recorded and **the underlying payment never occurred** | §5.3.2 — an evidential precondition, not an assertion by the caller |
| C2 | The correction **exactly reverses** the original journal entry | §5.3.3(1) |
| C3 | **Independent authorization and documented evidence** are mandatory | §5.3.3(3) |
| C4 | **No arbitrary payout, amount or recipient** is permitted | §5.3.3(2) |
| C5 | The affected account is **flagged and blocked from outgoing transactions until independently reconciled *and formally resolved*** | §5.3.4 |
| C6 | A genuine customer payment is **never reversed merely because staff later lost or misappropriated the cash** | §5.3.2, §5.4 — a separate workflow that leaves the borrower record intact |
| C7 | Sufficient available funds remain mandatory for **every genuine outgoing transaction**, without Owner/Admin override | §5.1, unchanged by this ruling |

**What this ruling does not grant.** It is not an override of A-4. It creates no
capability, argument or setting by which a genuine payout, refund, transfer,
expense or disbursement can proceed without funds. It governs one narrow act —
unwinding a receipt that never happened — which moves value to nobody.

### 1.3 Referred out of this plan

| Item | Disposition |
| --- | --- |
| Deposit-loss account and write-off procedure | **Separate review** (§6.7). `5960` and `5970` are already taken at the #27 head |
| Formal resolution of a correction shortfall (C5) | **Separate review** (§5.3.4). Reconciliation may *detect* it; it may not write it off automatically, and `5950` may not absorb it by default |
| A-10's reach into savings qualification, member-loan capacity and benefit gates | **Separate Product Owner ruling** per the review response (§15.6) |

---

## 2. Decision-to-requirement traceability matrix

| Decision / condition | Business rule | Design element | Migration step (§11.2) | Exact test |
| --- | --- | --- | --- | --- |
| **A-1** | 4 | `cash_receipt_confirmations`; `confirm_cash_receipt`; `confirmations_verifier_not_recorder` | 1 | `receipt-confirmation.test.ts :: refuses the recorder as confirmer, at both layers` |
| **A-1** batch | 4 | `confirm_cash_receipts(uuid[])` performing every per-receipt check, lock and idempotent transition | 1 | `receipt-confirmation.test.ts :: a batch refuses only the receipts the confirmer recorded, and confirms the rest` |
| **A-1** | 8 | availability = booked − pending | 1 | `cash-availability.test.ts :: a pending receipt does not raise availability` |
| **A-2** | 1 | `assert_cash_funds_available` on all 8 existing + 2 new outgoing paths | 6, 7 | `cash-sufficiency.test.ts :: refuses path <n> when the funding account is short` (×10) |
| **A-3** | 5, 8 | agency-verified float carries **no** confirmation row and is available on posting; non-agency wallet inflows carry one | 1 | `cash-availability.test.ts :: verified agency float is available on posting, with no confirmation row` |
| **A-3** | 8 | reconciliation is never a gate | 1 | `cash-availability.test.ts :: verified float is available before any reconciliation exists` |
| **A-4 / C7** | 1 | no settings flag, no override argument, no capability | 1, 6 | `cash-sufficiency.test.ts :: no actor, Owner included, can post a short genuine payout` |
| **A-5** | 2 | per-account availability; no aggregate consulted | 1 | `cash-availability.test.ts :: a sibling account's balance never funds this one` |
| **A-6** | 6 | `bank_value_date` evidence (may be historical, may fall in a closed period); clearance `entry_date` = `business_date()` | 5 | `bank-clearance.test.ts :: a historical value date posts to today, never to the value date` |
| **A-7** | 5 | full-amount clearance only; no automatic `5950` | 5 | `bank-clearance.test.ts :: a short credit blocks all clearance and posts nothing` |
| **A-8** | 5, 11 | rejection/bounce → `under_investigation`, **posting nothing**; till contra only on verified physical return | 5 | `deposit-investigation.test.ts :: rejection writes no journal and does not return cash to the till` |
| **A-8** | 7, 11 | `confirm_physical_cash_return` — distinct from the deposit recorder | 5 | `deposit-investigation.test.ts :: the deposit recorder cannot confirm its own physical return` |
| **A-9** | 7 | `request_clearance_reversal` (Manager) → `authorize_clearance_reversal` (Owner, ≠ verifier), **available** funds in the bank | 4, 5 | `bank-clearance.test.ts :: the verifier cannot authorize reversal of their own clearance` |
| **A-10** | 11 | one journal at receipt; confirmation off `loan_payments` | 1 | `receipt-confirmation.test.ts :: loan figures are identical before and after confirmation` |
| **A-11** | 10 | pre-write attempt record in its own transaction, **fail closed**; outcome written after | 9 | `refusal-audit.test.ts :: a failed attempt-log write prevents the payout` |
| **A-12** | 2, 3 | explicit branch authorization for non-Owner roles; both-branch authorization; line-level journal scoping | 8 | `rls-deposits.test.ts :: a NULL-branch non-Owner profile sees no branch` |
| **A-13** | 5 | distinct status domains, qualified labels | 5 | `bank-clearance.test.ts :: deposit clearance does not alter any loan status` |
| **C1, C6** | 11 | correction requires documented non-occurrence; a lost/misappropriated genuine payment is refused | 6 | `receipt-correction.test.ts :: refuses a correction where the payment did occur` |
| **C2, C4** | 11 | exact contra only; no amount, account or recipient argument | 6 | `receipt-correction.test.ts :: corrects only the entry it names, line for line` |
| **C3** | 11 | second actor + evidence artifact | 6 | `receipt-correction.test.ts :: requires documented evidence and a second actor` |
| **C5** | 1, 11 | account flagged; every outgoing path blocked until reconciled **and** formally resolved | 6 | `receipt-correction.test.ts :: an approved count alone does not clear the block` |
| **Rule 9** | atomic, concurrency-safe | PR #25 `post_journal` lock + lock-order contract | 1–9 | `cash-sufficiency-concurrency.test.ts` (whole file) |
| **Rule 10** | refusals move nothing | single-transaction refusal | 6 | `cash-sufficiency.test.ts :: a refusal writes no journal, line, document or status` |
| **Cutover** | 11 | documented counts and bank reconciliation before activation | — | `§11.4` — an operational gate, not a test |

---

## 3. What changes, and what must not

### 3.1 Untouched by design

1. **The double entry.** `post_journal` remains the only journal writer;
   append-only, balanced, source-idempotent; no historical entry re-posted.
2. **`loan_payments` and its guard.** `loan_payments_guard_mutation` permits
   exactly one transition, `posted → reversed`, and freezes every other column
   against the owner and `service_role` alike.
3. **The certified identities**, including the two a new `cash_kind` would
   otherwise break (§14).
4. **Daily reconciliation is never a gate on availability** (A-3), and never
   marks an unverified receipt spendable or posts an unapproved loss.
5. **Existing borrower, savings and benefit semantics.** A-10 covers borrower
   repayments expressly; it is not applied to savings qualification, member-loan
   capacity or benefit gates without a separate ruling (§15.6).

### 3.2 Non-negotiable invariants

1. A failed sufficiency check creates and mutates **no** financial document,
   posts no journal, changes no balance and advances no financial status. The
   nonfinancial attempt record is an exception to *no writes*, never to *no
   financial writes*.
2. A source account must hold enough **confirmed available** value where and
   when the transaction commits. Cash, bank and provider float are never pooled.
3. Posting and confirmation synchronize on the same account locks, acquired as a
   whole set in deterministic order.
4. Nobody verifies their own receipt or deposit; an Owner reversing a clearance
   is never its original verifier. Enforced in constraints **and** functions.
5. An `under_investigation` state is never presented as an accomplished return
   or loss.

---

## 4. Workstream D1 — availability primitives

### 4.1 `cash_receipt_confirmations`

```
id                    uuid pk
journal_entry_id      uuid not null unique references journal_entries(id)
account_id            uuid not null references ledger_accounts(id)
branch_id             uuid not null references branches(id)
amount                bigint not null check (amount > 0)
state                 text not null     -- 'pending' | 'confirmed' | 'disputed_void'
source_type           text not null
recorded_by           uuid, recorded_by_label text not null
confirmed_by          uuid, confirmed_by_label text, confirmed_at timestamptz
void_reason           text
created_at, updated_at
```

Constraints: `confirmed` requires all three confirmer columns;
`disputed_void` requires a reason; **`confirmations_verifier_not_recorder` —
`confirmed_by is null or confirmed_by <> recorded_by`** (A-1); one row per
journal entry; `reject_mutation()` on DELETE; a column guard making `amount`,
`account_id` and `journal_entry_id` write-once.

### 4.2 Which inflows carry a restriction (A-1, A-3)

Written by a helper invoked from inside `post_journal`, over the lines it is
handed — one place instead of eight, covering paths added later.

| Inflow | Restriction | Basis |
| --- | --- | --- |
| cash into a till — repayment, savings contribution, membership fee, meeting fine, other income | **pending until independently confirmed** | A-1 |
| an **agency / Mobile Money** transaction's float or cash leg | **none.** `verify_agency_transaction` already is the independent verification, and the journal is written *by* it, so the float is available on posting | A-3 — "no second physical-cash confirmation is added to electronic float itself" |
| a **non-agency** wallet inflow — a repayment or savings deposit keyed `mtn_mobile_money` / `airtel_money` through `post_payment` or `post_savings_deposit`, which post on recording with **no** verification step | **pending until independently verified** | A-1 by extension; **flagged for confirmation** at §15.1 |
| a direct bank credit into a bank account | **pending until independently verified** | evidence-led, as a deposit is |
| `opening_balance`, a transfer between own accounts, a deposit, a clearance, any reversal or contra line | **none** | already inside the business, or not a receipt |

**Reconciliation is never a precondition.** No availability function reads
`account_reconciliations`; a test asserts this against a database holding no
reconciliation row.

### 4.3 Functions and views

| Object | Shape | Notes |
| --- | --- | --- |
| `cash_account_available_balance(uuid) returns bigint` | `stable`, definer, no lock | booked − pending, for **one** account. Reads no sibling, no branch total, no reconciliation (A-3, A-5) |
| `assert_cash_funds_available(uuid, bigint)` | `volatile`, definer | `lock_ledger_balances(array[p_account_id])` **first**, then availability, then raise. **No override argument, no override setting** (A-4) |
| `assert_spendable_account(uuid, text)` | `stable`, definer | refuses `in_transit`, `agency_float`, headings, inactive and non-cash accounts |
| `cash_account_availability` view | `security_invoker`, revoke-then-grant | `(account_id, branch_id, booked, pending_in, available)`. No aggregate column |
| `confirm_cash_receipt(uuid)` / `confirm_cash_receipts(uuid[])` | definer, `receipts:confirm` | A-1's second actor. The batch form performs **every per-receipt** verifier-versus-recorder check, account lock and idempotent transition; it confirms what it may and refuses the rest, per receipt |
| `void_cash_confirmation(uuid, text)` | definer | for a receipt reversed before confirmation |

### 4.4 Settings — none

Decision A adds **no `finance_settings` column**. A switch that made
unconfirmed or uncleared money available would be the A-4 override under another
name. `allow_negative_cash` and `allow_negative_agency_float` are left exactly as
they are, are **read by nothing this plan adds**, and cannot reach availability;
a test asserts that setting both true does not permit a short payout.

---

## 5. Workstream D2 — universal enforcement, funding accounts, error correction

### 5.1 Enforcement (A-2, A-5, C7)

Every path in §8 calls `assert_cash_funds_available`, which consults **one
account**: the one money is leaving. No path sums a branch and no path falls
back to a sibling account. Paths that today call `assert_cash_available` move
onto the availability assert, so there is one rule rather than two.
`assert_cash_available` is retained for the booked question and for `1050`.

Aggregated branch liquidity is **informational only**: it is never a funding
source, never consulted by a sufficiency check, and never labelled spendable.

### 5.2 Explicit accounts, inbound as well as outbound (A-5, H1)

`branch_cash_account(branch, kind)` resolves `order by a.code limit 1`, and
`ledger_accounts_one_wallet_per_branch` excludes `bank`, so a branch may hold
several bank accounts — meaning `payment_method = 'bank'` silently pays from,
**and receives into**, the alphabetically lowest-coded one.

| Function | Change |
| --- | --- |
| `disburse_loan(p_loan_id)` | → `(p_loan_id, p_funding_account_id, p_branch_id default null)` |
| `post_savings_withdrawal(…)` | adds `p_funding_account_id` |
| `post_benefit_payment(…)` | adds `p_funding_account_id` |
| **Inbound destinations** — `post_payment`, `post_savings_deposit`, `record_membership_fee`, `post_meeting_fine_payment`, `record_other_income` | each gains an explicit `p_receiving_account_id`, because a receipt landing in an arbitrary bank account is the same defect facing the other way (review response H1: "bank inbound destinations and other ambiguous account selectors need equivalent review") |

Validation on each: exists, active, postable; `assert_spendable_account` for an
outbound account; belongs to the document's branch; **authorized under A-12
before any idempotent early return** (the Phase 4E branch-retry correction is
the precedent); and where a method is also given, its `cash_kind` agrees with
`payment_method_cash_kind(p_payment_method)`.

**Signature changes DROP then CREATE**, never a defaulted parameter, which would
create an overload PostgreSQL then refuses as ambiguous — the reason recorded in
`20261115001500` and `20261115000500`. There are **no internal database
callers** of the payout three; the inbound five are called by the server actions
and by test fixtures. Each DROP restates its `revoke`/`grant` pair in the same
migration, and all TypeScript callers, `types/database.types.ts` and the ADR-070
column test are updated with it.

### 5.3 Booking-error correction (the 2026-11-11 ruling)

#### 5.3.1 What it is for

One act: unwinding a receipt that was recorded although the underlying payment
never occurred. Value moves to nobody. It is **not** an override of A-4, and it
is reachable by no genuine payout path.

#### 5.3.2 The two cases that must never be confused (C1, C6)

| Case | What happened | Treatment |
| --- | --- | --- |
| **Booking error** | the payment **never occurred** — a mis-key, a duplicate entry, a receipt against the wrong borrower | `correct_misrecorded_receipt`, §5.3.3. The borrower's obligation is correctly restored, because they never paid |
| **Cash loss or misappropriation** | the payment **did occur** and the cash was afterwards lost, stolen or not banked | **`correct_misrecorded_receipt` is refused.** The receipt stands, the borrower's record is untouched, and the matter goes to the cash-loss investigation of §5.4 |

C6 is the condition that makes this distinction structural rather than
procedural: *"A genuine customer payment must never be reversed merely because
staff subsequently lost or misappropriated the cash."* A customer who paid has
paid. The business's loss is the business's, and it is never recovered by
re-indebting the customer.

So the correction's precondition is **documented non-occurrence**, established
by evidence, and the function refuses without it. Which evidence satisfies C1 is
flagged at §15.2 — it is an operational-policy question, not a code one.

#### 5.3.3 `correct_misrecorded_receipt(p_journal_entry_id, p_reason, p_evidence_path)`

Structurally incapable of being a payout:

1. **Exact contra only (C2).** The entry's own lines are read from
   `journal_lines`; the contra is the same accounts and amounts, opposite sides.
2. **No arbitrary payout, amount or recipient (C4).** The function accepts no
   amount, no account and no recipient. It cannot move value to anyone; it can
   only unwind the entry it names.
3. **Independent authorization and documented evidence (C3).** It requires
   `finance:correct`, refuses the profile that recorded the original receipt at
   the function layer **and** by a stored column pair, and requires both a reason
   and a non-blank `evidence_path` in the documents bucket — the
   `expenses.receipt_path` and deposit-slip pattern.
4. **Refused on every outflow and on anything already corrected.** Refused for
   any `source_type` that is an outflow — disbursement, withdrawal, benefit,
   expense, transfer, deposit, clearance and their reversals — so it reaches
   inflow entries only; refused on an entry already reversed or corrected,
   enforced by `journal_entries_one_per_source` on its own source type.
5. **Audited and notified.** Both actors' labels, the reason, the evidence path
   and the resulting balance in `audit_log`, plus a notification.

#### 5.3.4 The flag, and what clears it (C5)

Where the contra takes the account's booked balance below zero, the account is
set `requires_reconciliation`. While that flag stands, **every outgoing path
from that account is refused** — disbursement, withdrawal, benefit, transfer,
expense, deposit, agency and float alike.

**Two things are needed to clear it, not one.** C5 says *"independently
reconciled **and formally resolved**"*:

1. an independent count submitted and approved under the existing
   reconciliation maker-checker; **and**
2. a **formal resolution** of the shortfall.

**Reconciliation alone does not clear the flag, and nothing writes the shortfall
off automatically.** In particular `5950 Cash Over and Short` is **not** used by
default: A-7 forbids automatic variance journals, and the review response
forbids booking an expense merely because funds are under investigation. The
formal-resolution design — what the shortfall becomes, and who approves it — is
**referred for separate review** (§1.3) and is the subject of §15.3. Until it
exists, a corrected account stays flagged and blocked, which is the honest
state: nothing is written off and nothing is spent.

### 5.4 Cash loss and misappropriation (C6)

A separate workflow, outside Decision A's posting scope and outside this plan's
authorization:

- the receipt and its journal **stand**; the borrower's obligation, arrears and
  dates are untouched;
- the shortfall is an investigation with its own evidence and authorization;
- any eventual financial recognition — expense, receivable, or recovery — is
  part of the §15.3 formal-resolution review, not of this plan.

This is also what A-10 requires: a borrower's repayment is recognized on
recording, and a later failure of the business to hold the cash never silently
restores the borrower's debt.

---

## 6. Workstream D3 — Cash in Transit, clearance, exceptions

### 6.1 `1050 Cash in Transit`, and the three things that ship with it

One row per branch, `cash_kind = 'in_transit'`, asset, debit normal side, code
`1050-<branch>`. A sixth `cash_kind` has three inseparable consequences, all of
which happened verbatim when Phase 4A added the fifth (`20261107000900`):

1. **`branch_cash_position` gains an `in_transit` component, in the same
   migration.** `total_liquidity` is `sum(balance) where cash_kind is not null`,
   so a sixth kind that is not also a named component makes the parts stop
   summing to the total — two certified identities and three suites fail.
   **In-transit money stays inside book `total_liquidity`** and inside "every
   cash-kind GL account"; the figures that exclude it are the separate
   **spendable/available** columns. Aggregate ledger liquidity is never
   presented as spendable.
2. **`assert_cash_account` is hardened to refuse `in_transit`, in the same
   migration.** It tests only `cash_kind is null`, so the moment the kind is
   legal, Cash in Transit becomes a valid `record_transfer` endpoint — and
   `record_transfer` gates on `transfers:create`, which `secretary_treasurer`
   holds. Only the dedicated, authorized clearance and physical-return functions
   may move transit. This is the bypass Phase 4A closed for `agency_float` in
   the migration that created it: *"either without the other is a defect."*
3. **One `in_transit` account per branch**, enforced structurally, so
   alphabetical ordering can never pick a transit account.

`scripts/certify-financial-reconciliation.mjs` gains the component in its sum
identity — a certification-script change belonging to the implementation phase.

### 6.2 `bank_deposits`

```
id, deposit_number                 -- next_reference('bank_deposit')
branch_id, from_account_id         -- the till
transit_account_id                 -- 1050 for that branch
bank_account_id                    -- cash_kind = 'bank', same branch
amount                             -- > 0
deposit_date                       -- business_date() at recording
status                             -- 'submitted' | 'cleared'
                                   -- | 'under_investigation' | 'returned_to_till'
                                   -- | 'reversed'
bank_value_date, bank_reference, deposit_slip_path, clearance_notes
investigation_opened_at / _by / _reason
return_confirmed_at / _by / _evidence_path
reversal_requested_at / _by / _reason
recorded_by / _label
verified_by / _label / verified_at
decision_reason
deposit_journal_entry_id    uuid unique   -- till -> 1050, at recording
clearance_journal_entry_id  uuid unique   -- 1050 -> bank, at verification
return_journal_entry_id     uuid unique   -- 1050 -> till, at verified return
reversal_entry_id           uuid unique
idempotency_key             uuid not null unique
created_at, updated_at
```

`written_off` is **absent** from the status domain (§6.7). `rejected` is absent
too: under A-8 a refused deposit is `under_investigation`, not a closed state
(§6.4).

Constraints: amount positive; three distinct accounts in the same branch;
`(deposit_journal_entry_id is not null)` for every status;
`(status = 'cleared') = (clearance_journal_entry_id is not null)`;
`(status = 'returned_to_till') = (return_journal_entry_id is not null)`;
**`bank_deposits_verifier_not_recorder`** and
**`bank_deposits_returner_not_recorder`**; when `cleared`, `bank_reference`
non-blank and `bank_value_date`, `verified_by`, `verified_at` present;
`bank_value_date >= deposit_date` and `<= business_date()` (A-6); every
exception state requires a reason; `reject_mutation()` on DELETE and a column
guard making evidence write-once.

### 6.3 The functions

| Function | Capability | Behaviour |
| --- | --- | --- |
| `record_bank_deposit(from_account, bank_account, amount, description, idempotency_key, branch_id default null)` | `deposits:create` | lock on the key; **A-12 authorization before the replay return**; `assert_cash_funds_available(till, amount)` — a deposit **is** an outgoing path; posts Dr `1050` / Cr till; `submitted` |
| `verify_bank_deposit(deposit_id, bank_reference, bank_value_date, slip_path, notes)` | `deposits:verify` | `for update`; idempotent if `cleared`; **refuses the recorder** with `42501`; evidence validated; `assert_cash_available(transit, amount)`; **full amount only** (A-7); posts Dr bank / Cr `1050`, dated `business_date()` (A-6); `cleared` |
| `open_deposit_investigation(deposit_id, reason)` | `deposits:verify` | from `submitted` or `cleared`; **posts nothing**; `under_investigation` (A-7, A-8) |
| `confirm_physical_cash_return(deposit_id, evidence_path, notes)` | `deposits:verify` | only from `under_investigation`; **refuses the deposit's recorder**; requires evidence of **actual physical receipt**; posts Dr till / Cr `1050`; `returned_to_till` (A-8) |
| `request_clearance_reversal(deposit_id, reason)` | `deposits:request_reversal` (Manager) | only from `cleared`; records the request; **posts nothing** (A-9) |
| `authorize_clearance_reversal(deposit_id, evidence_path)` | `deposits:reverse` (**Owner only**) | only from `cleared` with a request on record; **refuses the original verifier**; **`assert_cash_funds_available(bank, amount)`** — the bank must hold the money as *available*, not merely booked (A-9); exact contra Dr `1050` / Cr bank; `reversed`, with the clearance evidence preserved in audit; stamps `reversed_by_entry_id`; if funds are short, **refuse and escalate** |

**A-9 needs all three parts:** a Manager request, Owner-only authorization, and
a row-level refusal of the original verifier — because an Owner also holds
`deposits:verify` and could otherwise verify and then reverse their own work.

### 6.4 A rejected deposit does not return cash automatically

**This corrects v2 of this plan**, which had `reject_bank_deposit` contra the
deposit entry and return the money to the till in one step. A-8 forbids it:
*"Cash returns to the till only after independently verified physical receipt."*
The original review package records the same point — the automatic
return-on-rejection proposal is superseded.

So the flow is: the bank refuses the deposit → `open_deposit_investigation`,
which posts **nothing** and leaves the money in `1050`, where it honestly is →
and only when somebody has physically handed the cash back and a second person
has verified receipt does `confirm_physical_cash_return` post Dr till / Cr
`1050`. A deposit that never comes back stays `under_investigation`.

### 6.5 A-6 — three dates, deliberately separated

| Date | Meaning | Rule |
| --- | --- | --- |
| `bank_value_date` | the bank's evidenced value date | **may precede verification and may fall in a closed reporting period.** Bounded only by `>= deposit_date` and `<= business_date()`. No arbitrary maximum window |
| `verified_at` | the actor event | the actual moment of verification |
| the clearance journal's `entry_date` | the **accounting** date | always `business_date()`. **Never** the value date, never backdated |

So a bank credit dated in a closed period is recorded faithfully as evidence,
and the accounting entry lands in today's open period. Nothing this plan adds
can post into a past period.

**The closed-period concept does not exist in the schema**, at 214 migrations:
no period table, no close or reopen, no `entry_date` constraint — and the
column's own comment records that *"a back-dated correction posts to the day it
happened"*. Three existing paths already accept an unbounded caller date:
`record_transfer(p_transfer_date)`, `record_expense(p_expense_date)`,
`record_other_income(p_income_date)`. Decision A satisfies A-6 inside its own
scope by never backdating at all; **enforcing A-6 system-wide is its own
workstream** (§15.4). The review package's test "attempt to post into closed
period" cannot be written until that exists.

### 6.6 Investigation outcomes

| Outcome | Posting | Status |
| --- | --- | --- |
| cleared after investigation | the normal clearance, Dr bank / Cr `1050`, with evidence, dated today | `cleared` |
| physical cash verified returned | Dr till / Cr `1050` | `returned_to_till` |
| unresolved | **nothing** | stays `under_investigation` |

### 6.7 Loss recognition is out of scope

`written_off` is absent from the status domain and a test asserts the outcome
does not exist, so the parked decision cannot be used by accident. Two notes for
that review: **`5960` is already `Agency Float Over and Short`** and `5970` is
`Agency Float Purchase Premium` at the #27 head, so a new code must be chosen
against the chart as it will then stand; and whether a loss becomes an expense
or a receivable naming an individual is HR-sensitive, not a chart question.

### 6.8 A-13 — one word, two domains

`bank_deposits.status = 'cleared'` and `loans.status = 'cleared'` are **both
correct and both retained**, in distinct schema and status domains. Managed by
separation, which the schema already provides: two independent `text` columns
with their own CHECKs — no shared enum, domain or lookup; no view, report or
function reading a bare `cleared` across both subjects; qualified labels
("Deposit cleared", "Loan cleared") in every screen, export and notification.
Tests assert that clearing a deposit alters no loan status and vice versa.

---

## 7. Workstream D4 — receipt confirmation without double-posting

A-10 decides the design; the schema admits one option.

| Option | Verdict |
| --- | --- |
| Post the journal at **verification** instead of receipt | **Refused.** `loan_payments.status` would need a third value, which `loan_payments_guard_mutation` refuses outright; and `loan_balances`, `loan_installment_coverage` and `payment_collection_totals` all filter `status = 'posted'`, so every borrower's arrears, coverage, delinquency state and loan clearance would change because the business had not yet counted its drawer — which A-10 forbids |
| Post to a **holding account** at receipt, transfer to the till on confirmation | **Refused.** Two journals per receipt, and it misstates where the cash physically is, so the daily count stops agreeing with the till |
| **One journal at receipt, plus a restriction record** | **Adopted** (§4.1) |

`post_payment`, `post_savings_deposit`, `record_membership_fee`,
`post_meeting_fine_payment` and `record_other_income` keep their existing
posting semantics; each writes exactly one journal, at receipt, debiting the
real cash account, using the **true recorded receipt date**. `post_journal`
additionally writes a `pending` confirmation row, which deducts from
availability and from nothing else.

Asserted: one journal per receipt; `loan_payments.status = 'posted'` at receipt
so every balance view, arrears figure, delinquency state, installment outcome
and deadline is **bit-identical** to today; the `1200`, `4100` and `2100`
identities; `loan_payments_guard_mutation` and the `payment_allocations`
no-update rule. Re-verification creates no journal, no duplicate credit and no
second availability change. A receipt reversed before confirmation voids its
pending row; a confirmed receipt reversed later is still subject to sufficiency.

---

## 8. The complete outgoing-path inventory

| # | Function | Credits | Today | After |
| --- | --- | --- | --- | --- |
| 1 | `post_disbursement_journal` (`disburse_loan`) | branch till | **none** | availability |
| 2 | `post_savings_withdrawal` | branch cash | **none** | availability |
| 3 | `post_benefit_payment` | branch cash | **none** | availability |
| 4 | `post_reversal_journal` (`reverse_payment`) | branch cash | **none** | availability; booking errors via §5.3 |
| 5 | `reverse_savings_transaction` | original cash account | **none** | availability; booking errors via §5.3 |
| 6 | `reverse_membership_fee` | receiving account | **none** | availability; booking errors via §5.3 |
| 7 | `reverse_meeting_fine_payment` | fine's cash account | **none** | availability; booking errors via §5.3 |
| 8 | `approve_reconciliation` (lending shortage) | counted account | **none** | availability + `lock_ledger_balances`, matching the agency twin, without letting a shortage drive available funds negative |
| 9–20 | `post_transfer_journal`, `reverse_transfer`, `post_expense_journal`, `reverse_other_income`, `post_agency_transaction`, `reverse_agency_transaction`, `post_agency_payable_settlement`, `post_float_replenishment`, `approve_agency_cash_reconciliation`, `approve_agency_float_reconciliation`, `reverse_commission_settlement`, `verify_agency_float_trade` / `reverse_agency_float_trade` | various | `assert_cash_available` / float assert | availability |
| **21** | **`record_bank_deposit`** | branch till | — | availability |
| **22** | **`verify_bank_deposit`** | `1050` | — | `assert_cash_available` on transit |
| **23** | **`confirm_physical_cash_return`** | `1050` | — | `assert_cash_available` on transit |
| **24** | **`authorize_clearance_reversal`** | bank account | — | **availability** (A-9) |

Completeness is demonstrated by **scanning every `post_journal` call site at the
branch head**, not by reading the seeded source types — which is how paths 4–8
were missed in the first inventory.

---

## 9. Workstream D6 — refusal-attempt audit, fail closed

### 9.1 It cannot be done inside the financial transaction

Rule 10 refuses by aborting the transaction, and the abort takes any log row
with it. The in-database answer would be an autonomous transaction, and this
deployment has no mechanism for one: the only installed extension is `pg_trgm`
— no `dblink`, no `pg_background`, no `pg_cron`.

### 9.2 Pre-write, then outcome — fail closed (A-11)

**This replaces v2's post-rollback best-effort design**, which recorded refusals
after the fact and let a logging outage lose the evidence. A-11 says fail
closed, and the review package's design is adopted:

1. **Before** calling the payout RPC, the server action writes a durable attempt
   record in its **own committed transaction**: actor, branch, type, account,
   amount, time — server-derived, never from client input.
2. **If that write fails, the payout is not attempted.** Fail closed.
3. The payout RPC is called.
4. The outcome — refused with its SQLSTATE and reason, or succeeded — is written
   to the same record in a separate transaction.
5. An attempt with no outcome is a monitored anomaly, not a silent gap.

**Why this direction is safe.** The attempt log can only ever *prevent* a
payout, never permit one. It is nonfinancial, lives outside every financial
transaction, and is never read by any authorization, sufficiency, approval,
confirmation, clearance or correction decision.

**The operational consequence is real and is stated rather than hidden:** the
attempt log becomes an availability dependency of every payout, so an outage
stops the counter. The continuity arrangements for that are an operational
requirement (§15.7), and this plan does **not** claim exactly-once delivery
under arbitrary infrastructure failure.

### 9.3 Data minimization and access

No credentials, no raw provider secrets, no unnecessary customer data, no excess
identifying detail. Append-only (`reject_mutation()` on UPDATE except the single
outcome write, and on DELETE), branch-scoped, `select` gated on
`audit:view_refusals`, rate-limited per actor through the existing
`rate_limit_counters`, with a documented retention and purge policy. A
user-visible refusal gives a friendly reason without system internals, and a
security refusal does not disclose that an inaccessible account exists.

---

## 10. Workstream D5 — branch-scoped finance, and Head Office

### 10.1 Reuse the operating-branch rule

PR #27's `20261115001500_agency_operating_branch.sql` already settles the
selection half and records why guessing is worse than refusing:
`create_agency_transaction` fell back to the alphabetically first active branch,
right by accident with one branch and misrouting five counter tests the moment a
second existed. Head Office is exactly the affected officer — the Owner and the
Secretary both carry `profiles.branch_id = null`.

The rule, called rather than re-derived: *a branch-less officer names the
operating branch, a branch-assigned officer records at their own and may name no
other, the branch is validated against what the officer may see, and it must be
open.* `p_branch_id uuid default null` goes **last**, so positional calls by
branch-assigned officers stay valid.

### 10.2 `NULL` must stop meaning "all branches" for ordinary users

A-12 is explicit: *no `NULL ⇒ all branches` fallback for ordinary users.*

`user_can_see_branch(uuid)` returns **true for any profile whose `branch_id` is
null**, and today **every** profile's is null — so applying the existing
predicate would grant every Manager and Secretary every branch, which is the
opposite of A-12. The predicate must be refined so that unrestricted access
follows from the **`owner_admin` role**, and every other role requires an
explicit authorized-branch set.

Two consequences, both of which need decisions (§15.5):

- an explicit authorization set is new state — a `profile_branches` grant table
  or an equivalent — because `profiles.branch_id` is a single column and Head
  Office staff may legitimately be authorized for several branches;
- existing staff accounts currently enjoy unrestricted access, so the migration
  that narrows it **changes what real users can see**. Which branches each
  existing non-Owner account is authorized for is a data decision the Product
  Owner must make; it cannot be derived.

### 10.3 Reads, writes and multi-branch entries

- **Writes.** `user_can_see_branch` (as refined) added to `record_transfer`,
  `approve_transfer`, `reject_transfer`, `reverse_transfer`, the three expense
  functions, `record_other_income`, `reverse_other_income`,
  `submit_reconciliation`, `approve_reconciliation`, `disburse_loan`,
  `post_payment` and `reverse_payment` — each **before** any idempotent early
  return.
- **Cross-branch movements need both-branch authorization.** `record_transfer`
  takes its branch from the source account; a transfer whose two legs belong to
  two branches must be authorized for **both**, not just the source.
- **Reads, and the multi-branch journal problem.** `journal_entries` carries one
  `branch_id`, but its **lines** can touch accounts of two branches — exactly
  what a cross-branch transfer produces — and `journal_lines` carries no branch
  of its own. So a predicate on the header alone both over- and under-discloses:
  it hides the entry from the second branch entirely while exposing, to the
  first, lines belonging to accounts it may not see. The design must scope
  `journal_lines` by **its account's** branch, and state a rule for header
  visibility on a cross-branch entry. Flagged at §15.5.

### 10.4 Capabilities

| Capability | `secretary_treasurer` | `manager` | `owner_admin` |
| --- | --- | --- | --- |
| `deposits:view` / `deposits:create` | ✓ | ✓ | ✓ |
| `deposits:verify` | | ✓ | ✓ |
| `deposits:request_reversal` | | ✓ | ✓ |
| `deposits:reverse` | | | **✓ only** |
| `receipts:confirm` | | ✓ | ✓ |
| `finance:correct` | | ✓ | ✓ |
| `audit:view_refusals` | | ✓ | ✓ |

No capability here overrides sufficiency; under A-4 none can. The distinct-actor
rules do the real work, because `manager` and `owner_admin` necessarily hold
both sides of several pairs.

---

## 11. Migration order and safety

### 11.1 Branch point

| Candidate | Verdict |
| --- | --- |
| Audited base `64ea09c` (161) | **No.** No `lock_ledger_balances`, no `post_journal` lock |
| PR #25 head (194) | **No.** Has the locking, not the operating-branch rule |
| **PR #27 head (214)** | **Yes.** Carries both. Re-check the live head immediately before branching |

Migrations are dated **after the greatest ID in the parent** — `20261115001600`
when audited; verify again at branch time. PRs #26 and #27 redefine **none** of
`post_journal`, `assert_cash_available`, `lock_ledger_balances`,
`disburse_loan`, `post_payment`, `post_reversal_journal`,
`post_savings_withdrawal` or `post_benefit_payment`, so Decision A's changes are
conflict-free against both. `branch_cash_position` was last redefined by
`20261107000900`; extend **that** version. No rebase or force push across the
stack without approval. PR #19's independent security work stays visible for the
combined rehearsal.

### 11.2 Order

| Step | Migration | Must precede |
| --- | --- | --- |
| 1 | `cash_receipt_confirmations`, availability functions and view, `assert_spendable_account`. **No settings column** | everything |
| 2 | `in_transit` kind **+** `branch_cash_position` component **+** `assert_cash_account` hardening **+** uniqueness — **one indivisible migration** | any `1050` row |
| 3 | `1050-<branch>` chart rows, idempotently, including for branches created later | the deposit document |
| 4 | the new `source_type` values, the `bank_deposit` reference scope, the new capabilities | the deposit functions |
| **5a** | **branch authorization: the grant model, the refined predicate, write-path checks, line-level read scoping** | step 6 — see below |
| 5b | `bank_deposits` + its six functions | the UI |
| 6 | `assert_cash_funds_available` wired into paths 1–8; the DROP/CREATE signature changes **including inbound destinations**; `correct_misrecorded_receipt`; the `requires_reconciliation` flag and its block | the UI |
| 7 | paths 9–24 moved onto the availability assert | — |
| 8 | `refused_financial_actions` + its RPC | the server actions |

**Branch authorization moves ahead of the funding-account selectors**, per the
review response: an explicit account-ID parameter is an access vector, so
without branch scoping a caller could name another branch's account. Step 5a is
therefore a precondition of step 6, not a later tidy-up.

Step 2 is indivisible for the reason Phase 4A gave about `agency_float`: one
half breaks the certified identities, the other opens a bypass of the control
being built.

### 11.3 Historical accounting is preserved by construction

Both halves are built so **the absence of a record means available**: no
historical inflow has a confirmation row, and `1050` opens at zero. At cutover
no row is written, no journal is posted and **no historical figure moves**.
Backfilling confirmation rows, or re-posting historical deposits through `1050`,
is refused.

Specifically protected: the derived opening entry of **21,449,163** and the
assertion that Cash at Hand touches exactly zero at its lowest historical point;
`journal_entries_guard_update`, which is why clearance state lives on its own
table; and every existing migration, neither edited, renamed nor re-ordered.

### 11.4 But technical compatibility is not financial assurance

**This is the review package's caveat, and it is adopted.** "Absent means
available" guarantees that no historical figure moves. It does **not** establish
that legacy till cash is physically present, or that legacy bank deposits ever
cleared.

So before any **live activation** on real money, and independently of the code:

1. signed **per-account physical till counts** for every cash and wallet account;
2. **bank confirmations and statement reconciliation** for every bank account;
3. identification of deposits and receipts outstanding at the moment the controls
   start;
4. resolution of every discrepancy, or its explicit recording;
5. a documented **initial verified available position** per account, approved by
   the Owner.

Unverified historical funds are not silently imported as available. This is an
operational gate, not a test, and it is a precondition of activation rather than
of merge.

### 11.5 Mechanics

`ledger_accounts_cash_kind_valid` and `journal_entries_source_valid` are widened
by drop-and-recreate, **preserving every existing alternative verbatim**, and
their **live definitions and permissions are introspected at the base before the
DDL is written** — Phase 4A found the architecture specification had both
constraint names wrong and would have aborted if transcribed. New columns are
registered in `tests/db/postgrest-columns.test.ts` (ADR-070) and types
regenerated with `npm run db:types`. **No feature flag and no settings column**:
§11.3 makes the transition a no-op and under A-4 a flag would be an override.

**No migration is applied to production.** The existing blockers — the
Git-linked Supabase branch reporting `MIGRATIONS_FAILED`, GitHub protections,
deploy access and custom domain, backup and recovery, provider commercial terms
and ceilings, Decision L and membership policy activation — are independent of
this work.

---

## 12. Concurrency and the lock-order contract

1. **Global order unchanged:** provider lock → account locks (sorted) →
   reference counter. New paths take account locks only through
   `lock_ledger_balances`, which sorts, de-duplicates and drops nulls.
2. **Availability is computed under the lock, after it** — the construction
   `20261109000100` chose.
3. **Multi-account postings lock the whole set up front, sorted**, before the
   sufficiency check: a clearance touches `1050` and the bank; a verified return
   touches `1050` and the till. PR #25's transfer fix showed that holding an
   out-of-order subset is what deadlocks once `post_journal` locks the entry.
4. **Confirmation locks the account it makes available.**
5. **Nothing is cached** (ADR-052).
6. **Idempotency on every new write path:** `idempotency_key uuid not null
   unique`, advisory lock on the key first, **authorization — capability *and*
   branch — above the replay shortcut** (ADR-056 and the Phase 4E branch-retry
   correction), verification idempotent on an already-cleared deposit.
7. Duplicate provider-reference controls apply in their existing scope; a manual
   reference is never read as evidence of a live provider integration.

---

## 13. Exact tests for each critical financial control

### 13.1 PostgreSQL (`tests/db/`, `vitest --project db`)

**`cash-sufficiency.test.ts`**
- `refuses path <n> when the funding account is short` — **twelve cases**, paths
  1–8 and 21–24.
- `a refusal writes no journal, line, document or status` — per path.
- `refuses when booked is sufficient but available is not`.
- `permits once the receipt is confirmed`; `permits once the deposit is cleared`.
- `no actor, Owner included, can post a short genuine payout`.
- `allow_negative_cash and allow_negative_agency_float do not relax availability`.
- `refuses 1050 as a funding account` — per path; plus a direct-RPC attempt.
- `refuses a funding account from another branch`.
- `a branch aggregate never funds an account-specific shortage` (A-5).

**`cash-availability.test.ts`**
- `available equals booked minus pending`.
- `a pending receipt does not raise availability`.
- `verified agency float is available on posting, with no confirmation row` (A-3).
- `verified float is available before any reconciliation exists` — on a database
  with **no** `account_reconciliations` row.
- `no availability function reads account_reconciliations`.
- `a sibling account's balance never funds this one`; `no availability function
  consults a branch total`.
- `no confirmation row means fully available` — against the demo book.
- `reversing a pending receipt voids its deduction`.
- `in-transit money is inside book total_liquidity and outside available`.

**`receipt-confirmation.test.ts`**
- `loan figures are identical before and after confirmation` — `loan_balances`,
  `loan_installment_coverage`, `payment_collection_totals`, arrears, installment
  outcomes, deadlines, delinquency state and loan clearance against pre-change
  snapshots.
- `a receipt writes exactly one journal`; `confirmation writes no journal`;
  `re-verification changes nothing`.
- `refuses the recorder as confirmer, at both layers`.
- `a batch refuses only the receipts the confirmer recorded, and confirms the rest`.
- `a duplicate batch confirmation is idempotent`.
- `the repayment date is the recorded date, not the verification date` (A-10).
- `late verification does not move the borrower's repayment date`.

**`bank-clearance.test.ts`**
- `a short credit blocks all clearance and posts nothing` (A-7).
- `requires a bank reference, a value date and a verifier`.
- `a historical value date posts to today, never to the value date` (A-6).
- `a value date in a closed reporting period is accepted as evidence` (A-6).
- `refuses a value date before the deposit date`; `refuses one in the future`.
- `the verifier cannot be the recorder` — function **and** CHECK.
- `a Manager may request but not authorize a reversal` (A-9).
- `only an Owner may authorize a reversal`; `the verifier cannot authorize
  reversal of their own clearance`.
- `a reversal is refused when the bank's available funds are short` (A-9).
- `refuses a second clearance of one deposit`.
- `a reversal returns money to transit, not to the till`.
- `refuses a transfer out of 1050`, including by direct RPC.
- `deposit clearance does not alter any loan status`; `loan clearance does not
  alter any deposit status` (A-13).
- `a deposit is refused when the till is short`.

**`deposit-investigation.test.ts`**
- `rejection writes no journal and does not return cash to the till` (A-8).
- `opening an investigation writes no journal`.
- `the deposit recorder cannot confirm its own physical return`.
- `a return requires documented evidence of physical receipt`.
- `a verified return posts Dr till / Cr transit and nothing else`.
- `an unresolved deposit stays under investigation indefinitely`.
- `no write-off outcome exists` — asserts the status domain and signatures.
- `an under-investigation deposit is never reported as returned or written off`.

**`receipt-correction.test.ts`**
- `corrects only the entry it names, line for line` (C2).
- `accepts no amount, account or recipient` (C4).
- `refuses a correction where the payment did occur` (C6).
- `a lost or misappropriated receipt leaves the borrower's record untouched` (C6).
- `requires documented evidence and a second actor` (C3).
- `refuses the person who recorded the original receipt`.
- `refuses every outflow source type`; `refuses an already-corrected entry`.
- `flags the account when the contra goes below zero` (C5).
- `every outgoing path from a flagged account is refused` — per path.
- `an approved count alone does not clear the block` (C5).
- `no shortfall is written off automatically, and 5950 is not touched` (A-7).
- `the correction path cannot pay anybody`.

**`cash-sufficiency-concurrency.test.ts`** — real parallel connections, extending
PR #25's advisory-lock harness so reference-number serialization cannot create
false passes: two simultaneous debits; confirmation versus payout; clearance
versus payout; transfer versus deposit; two verifications of one deposit; two
cross-branch or float operations; a correction racing a payout; verified return
versus payout; and the lock-order deadlock probe over `1050` + bank and `1050` +
till in opposing orders. Deadlock and stale-read paths are exercised
deliberately. Each case holds **only** the account's advisory lock, posts
nothing, takes no reference, and distinguishes *refused* from *walked past*.

**`refusal-audit.test.ts`**
- `a failed attempt-log write prevents the payout` (A-11, fail closed).
- `an attempt record exists independently of the failed financial transaction`.
- `a refused payout leaves an attempt record and no financial row`.
- `actor, branch and account are server-derived and cannot be forged`.
- `the logging RPC cannot write a journal`.
- `an attempt with no outcome is detectable`.
- `the log is append-only beyond its single outcome write`.
- `unauthenticated and cross-branch reads are refused`.
- `rate limiting applies per actor`; `retention and purge behave as specified`.
- `no financial function reads refused_financial_actions`.

**`rls-deposits.test.ts`** — real JWT role and branch matrix.
- `anon is denied on every new table and view`; `no INSERT, UPDATE or DELETE
  grant exists`.
- `a NULL-branch non-Owner profile sees no branch` (A-12).
- `an Owner sees every branch`.
- `a Head Office user must name an authorized operating branch`.
- `a branch-scoped profile cannot fund from, or deposit into, another branch`.
- `a cross-branch transfer requires authorization for both branches`.
- `journal lines of an inaccessible branch are not disclosed on a cross-branch
  entry`.
- `inactive and forced-password-change sessions are refused`.
- `direct Data API and raw RPC bypass attempts are refused`.

**Identity and regression.** `trial_balance` foots; `1050` equals the sum of
submitted and under-investigation deposits; the `1200`, `4100`, `2100`
identities; `total_liquidity` equals its six named components and every
cash-kind GL account; the opening entry is 21,449,163 and the till still touches
zero. **Every existing suite passes unchanged.** Savings eligibility, membership
qualification, benefit gates and finance reporting are retested **separately**,
not inferred from A-10.

### 13.2 Integration (`vitest --project integration`)

Friendly refusal messages without internals; security refusals that do not
disclose inaccessible accounts; funding and receiving account arguments and the
branch argument validated and safely rejected when absent, malformed or
unauthorized; rate limiting intact; `revalidatePath` coverage; the attempt-log
pre-write and its fail-closed behaviour; `audit:money` over new money TypeScript.

### 13.3 Browser (Playwright)

`bank-deposits.write.spec.ts` — record; see it excluded from available funds;
verify as a **second** user; the recorder's verify attempt refused; a Manager
requests and an Owner authorizes a reversal; the verifier's authorize attempt
refused; an investigation shown as neither returned nor written off.
`cash-sufficiency.write.spec.ts` — a funding-account picker showing
**available** balances per account, never one aggregated bank figure; aggregate
liquidity labelled informational; submit blocked when short; the server still
refusing when the form is bypassed; the same on withdrawal and benefit screens;
a Head Office officer prompted to name the operating branch and a
branch-assigned officer not offered another.
`receipt-confirmation.write.spec.ts` — a receipt visible as Pending
Confirmation, confirmable only by a second user, batch confirmation.
Plus: in-transit ageing visible; deposit and loan clearance labelled distinctly;
no partial state after a refusal and reload; `@axe-core/playwright` and
responsive passes on every new screen, with a fresh seed.

### 13.4 Release

`npm run verify`, `npm run test:db`, `npm run audit:money`, the database
security gate, `scripts/certify-financial-reconciliation.mjs` **with its sum
identity extended for `in_transit`**, migrations-on-empty, the full historical
upgrade replay with every tracked fixed-point value compared, the PostgreSQL 17
rehearsal, browser E2E on a fresh seed, and **all four required GitHub jobs green
at the final audited code SHA**. Migration ordering is verified independently
against PR #19. **No test is weakened to achieve green**, and green CI is not
permission to merge or deploy.

---

## 14. The invariant register

| Invariant | Where asserted |
| --- | --- |
| Every journal balances; every entry has ≥ 2 lines | deferred constraint triggers |
| One journal per `(source_type, source_id)` | `journal_entries_one_per_source` |
| Append-only ledger; one mutable column on an entry | `journal_lines` triggers, `journal_entries_guard_update` |
| `trial_balance` foots and equals the journal | certification identities |
| `total_liquidity` = its **six** named components, and = every cash-kind GL account | certification identities, **to extend** |
| `1200` = `principal_outstanding`; `4100` = interest collected; `2100` = `sum(signed_amount)` | certification identities, savings suites |
| Loan figures unchanged by confirmation | `receipt-confirmation.test.ts` |
| `loan_payments` admits exactly one status transition | `loan_payments_guard_mutation` |
| Opening entry = 21,449,163; till touches zero | ledger suite |
| A refused payout writes nothing financial | `cash-sufficiency.test.ts` |
| No actor or setting overrides sufficiency for a genuine outgoing transaction | `cash-sufficiency.test.ts` (A-4, C7) |
| Availability reads one account — never an aggregate, never a reconciliation | `cash-availability.test.ts` (A-3, A-5) |
| No accounting entry is dated earlier than today, within this plan's scope | `bank-clearance.test.ts` (A-6) |
| A genuine customer payment is never reversed for a staff cash loss | `receipt-correction.test.ts` (C6) |
| No variance or loss is journalled automatically | `receipt-correction.test.ts`, `deposit-investigation.test.ts` (A-7) |
| Cash returns to a till only on independently verified physical receipt | `deposit-investigation.test.ts` (A-8) |
| A logging failure never permits a payout | `refusal-audit.test.ts` (A-11) |
| No cash-kind account is reachable by a generic transfer unless spendable | `assert_cash_account`, `bank-clearance.test.ts` |
| Availability is derived, never stored | code review, ADR-052 |

---

## 15. Open items

Flagged, not decided.

1. **Non-agency wallet inflows** (§4.2). A-3 forbids adding a second
   confirmation to electronic float that the agency module already verifies. But
   a repayment keyed `mtn_mobile_money` through `post_payment` has **no**
   verification step at all. This plan restricts those, so unverified money is
   not spendable. **Confirm**, or rule that a provider reference is itself
   sufficient evidence.
2. **What evidence establishes C1** — that a payment never occurred. An
   operational-policy question: which documents or system records must be
   attached before a correction may proceed.
3. **Formal resolution of a correction shortfall (C5)** and the deposit-loss
   treatment — both referred for **separate review**, together, since both
   decide who bears a loss. Until then a corrected account stays flagged and
   blocked and no deposit is written off. Note the `5960`/`5970` collision.
4. **Closed accounting periods do not exist** (§6.5). A-6 forbids backdating
   into one; the schema has no period, close, reopen or `entry_date` guard, and
   three existing paths accept unbounded dates. Decision A complies inside its
   own scope by never backdating. **Enforcing A-6 system-wide is its own
   workstream**, and the review package's "post into closed period" test cannot
   be written until it exists.
5. **A-12's branch authorization model** (§10.2, §10.3): the grant model for
   multi-branch Head Office staff; **which branches each existing non-Owner
   account is authorized for**, which cannot be derived and will change what
   real users see; and the header-visibility rule for a cross-branch journal
   entry whose lines span two branches.
6. **A-10's reach beyond the loan book.** Expressly approved for borrower
   repayments. Savings qualification, contribution months, member-loan capacity
   and benefit eligibility are **not** inferred from it and need a separate
   ruling.
7. **Operational supervision and continuity** (§9.2, §11.4): pending-cash
   ageing, abandoned deposits, attempt-log health and unresolved attempts, and
   what the counter does during an attempt-log outage — given that fail-closed
   makes it a hard dependency of every payout.
8. **Confirmation throughput** (A-1): per-receipt confirmation is implemented
   with a batch action; confirm the batch granularity operations needs.
9. **Six new ADRs** are implied, from ADR-072: availability as a restriction
   rather than a second ledger; Cash in Transit for bank deposits and not for
   till cash; confirmation off the receipt row; refusal audit outside the
   financial transaction, fail closed; A-13's two-context `cleared`; and the
   booking-error correction with its seven conditions. The first supersedes the
   settlement-status note at the head of `20261020000400`.
