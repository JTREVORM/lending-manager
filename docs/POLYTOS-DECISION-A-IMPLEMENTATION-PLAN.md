# POLYTOS — Decision A Implementation Plan

**Revision:** v2, reconciled against the Product Owner's policy corrections of
2026-11-11. Supersedes v1 (commit `38a7e3d`).
**Status:** awaiting development authorization. **Not authorized.**
**Type:** documentation only. No migration, no application code, no test change,
no deployment configuration, no PR branch touched.
**Branch point:** PR #27 head (`phase4e/mobile-money-2026-11-09`, 214 migrations) — §11.1.
**Companion:** `docs/POLYTOS-DECISION-A-TECHNICAL-REVIEW.md` v2.
**Historical record:** `docs/POLYTOS-DECISION-A-GAP-ANALYSIS.md` is left as written;
the review document lists the statements in it that this revision supersedes.
**Production:** NO-GO. Draft PRs #25, #26 and #27 untouched.

---

## 1. The approved decision set

A-1 through A-13 answer the thirteen open questions in the gap analysis §9. The
five rulings corrected by the Product Owner on 2026-11-11 are marked
**CORRECTED**, with what v1 of this plan had assumed and what it now implements.

| ID | Ruling | Change from v1 |
| --- | --- | --- |
| **A-1** | Physical cash receipts require **independent verification** — confirmed by somebody other than the person who took it | — |
| **A-2** | Sufficiency applies to **every outgoing financial path** | — |
| **A-3** | **CORRECTED.** Independently verified and posted MTN/Airtel float is **immediately available**. Availability never waits on daily reconciliation | v1 implied a reconciliation dependency. Removed entirely (§4.2, §4.5) |
| **A-4** | **CORRECTED.** **No sufficient-funds override exists, for anybody, including Owner/Admin.** No `allow_negative_available` setting | v1 proposed `allow_negative_available` and an Owner-only correction override. **Both deleted** (§4.4, §5.3) |
| **A-5** | **CONFIRMED.** Sufficiency is **account-specific, never a branch aggregate** | v1 carried this as an assumption; now ruled and tested (§5.1) |
| **A-6** | **CORRECTED.** Bank **value dates may be historical**; **accounting entries must not be backdated into closed periods** | v1 conflated the two dates. They are now separated, and the closed-period concept is flagged as absent from the schema (§6.5, §15.1) |
| **A-7** | Clearance is for the **full amount** or not at all | — |
| **A-8** | A deposit the bank refuses enters a **bounced-deposit investigation** | Write-off outcome **deferred to separate review** (§6.6) |
| **A-9** | Clearance reversal is **Owner-only, with separation of duties** | — |
| **A-10** | A pending receipt changes **nothing in the loan book**; loan repayments are never double-posted | — |
| **A-11** | **Nonfinancial refusal-audit logging** that cannot bypass financial controls | — |
| **A-12** | **Branch-scoped finance access**, with Head Office branch selection | — |
| **A-13** | **CORRECTED.** Bank deposit `cleared` and loan `cleared` are **distinct context-specific statuses**; both keep the word | v1 proposed avoiding the word for deposits. Reversed; the mitigation is context separation, not renaming (§6.7) |

### 1.1 Two items referred out of this plan

| Item | Disposition |
| --- | --- |
| The Owner-only correction override proposed in v1 §5.3 | **Not approved.** Replaced by the error-correction design in §5.3, which engages no override |
| The deposit-loss account and write-off procedure proposed in v1 §6.4 | **Separate review.** Removed from scope; §6.6 states what remains and what is parked |

---

## 2. Decision-to-requirement traceability matrix

Each row is traceable end to end: ruling → business rule → design → migration
step → the exact test that proves it. Test cases are named in §13.

| Decision | Business rule | Design element | Migration step (§11.2) | Exact test |
| --- | --- | --- | --- | --- |
| **A-1** | 4 — physical cash confirmed received | `cash_receipt_confirmations`; `confirm_cash_receipt`; `confirmations_verifier_not_recorder` | 1 | `receipt-confirmation.test.ts :: refuses the recorder as confirmer, at both layers` |
| **A-1** | 8 — pending receipts cannot support payouts | availability = booked − pending | 1 | `cash-availability.test.ts :: a pending receipt does not raise availability` |
| **A-2** | 1 — sufficient available funds | `assert_cash_funds_available` on all 8 existing + 2 new outgoing paths | 6, 7 | `cash-sufficiency.test.ts :: refuses path <n> when the funding account is short` (×10) |
| **A-3** | 5, 8 — wallet float | wallet inflow confirmed by independent verification, then immediately available; no reconciliation gate | 1 | `cash-availability.test.ts :: verified wallet float is available before any reconciliation exists` |
| **A-4** | 1 — no override | no settings flag; no override argument; no capability | 1, 6 | `cash-sufficiency.test.ts :: no actor, Owner included, can post a short payout` |
| **A-5** | 2 — accounts independently controlled | per-account availability; no aggregate consulted | 1 | `cash-availability.test.ts :: a sibling account's balance never funds this one` |
| **A-6** | 6 — clearance evidence | `cleared_on` is evidence and may be historical; the clearance journal's `entry_date` is `business_date()` | 5 | `bank-clearance.test.ts :: a historical value date posts to today, never to the value date` |
| **A-7** | 5 — cleared before spendable | full-amount clearance only | 5 | `bank-clearance.test.ts :: refuses a clearance for less than the deposit` |
| **A-8** | 5, 11 — bounced deposit | `under_investigation`; posts nothing; two approved outcomes | 5 | `deposit-investigation.test.ts :: opening an investigation writes no journal` |
| **A-9** | 7, 11 — verified by a different person | `deposits:reverse` (Owner) **and** a row-level refusal of the verifier | 4, 5 | `bank-clearance.test.ts :: the verifier cannot reverse their own clearance` |
| **A-10** | 11 — auditable; no double posting | one journal at receipt; confirmation off `loan_payments` | 1 | `receipt-confirmation.test.ts :: loan figures are identical before and after confirmation` |
| **A-11** | 10 — refusals move nothing | `refused_financial_actions`; post-rollback application write | 9 | `refusal-audit.test.ts :: a refused payout leaves a log row and no financial row` |
| **A-12** | 2, 3 — branch control | `user_can_see_branch` on write paths; branch predicate on ledger reads; the operating-branch rule reused | 8 | `rls-deposits.test.ts :: a branch-scoped profile cannot fund from another branch` |
| **A-13** | 5 — vocabulary | `bank_deposits.status = 'cleared'` and `loans.status = 'cleared'` kept separate by context | 5 | `bank-clearance.test.ts :: deposit clearance does not alter any loan status` |
| **§5.3** | 11 — corrections auditable | `correct_misrecorded_receipt`: exact contra only, maker-checker, payout block | 6 | `receipt-correction.test.ts` (whole file) |
| **Rule 9** | atomic, concurrency-safe | PR #25's `post_journal` lock + the lock-order contract | 1–9 | `cash-sufficiency-concurrency.test.ts` (whole file) |
| **Rule 10** | refused payouts move nothing | single-transaction refusal, unchanged | 6 | `cash-sufficiency.test.ts :: a refusal writes no journal, line, document or status` |

---

## 3. What changes, and what must not

### 3.1 Untouched by design

1. **The double entry.** No account renamed, no direction reversed, no existing
   journal line moved.
2. **`loan_payments` and its guard.** `loan_payments_guard_mutation` permits
   exactly one transition, `posted → reversed`, and freezes every other column
   against the owner and `service_role` alike. Nothing is added to it.
3. **The certified identities**, including the two a new `cash_kind` would
   otherwise break (§14).
4. **Daily reconciliation is never a gate on availability** (A-3). It remains
   what it is: evidence, compared after the fact.

### 3.2 Mechanism per rule

| Rule | Mechanism |
| --- | --- |
| 1, 8 — sufficient available funds | `assert_cash_funds_available()`, lock-first, on every outgoing path, with **no override of any kind** (§5) |
| 1 — selected funding account | an explicit account argument replacing method-implied resolution (§5.2) |
| 2 — independent control | per-account availability; explicit account selection; no aggregate (A-5) |
| 3 — no cross-account borrowing | unchanged; enforcement makes refusal the outcome rather than overdraft |
| 4 — physical cash confirmed | `cash_receipt_confirmations`; one journal at receipt (§4, §7) |
| 5 — bank deposits cleared | `1050 Cash in Transit` + `bank_deposits` (§6) |
| 6 — clearance evidence | evidence columns, CHECK-required when cleared; value date separated from accounting date (§6.5) |
| 7 — different verifier | distinct-actor at function **and** constraint layer (§6.3) |
| 9 — atomic, concurrency-safe | PR #25's lock + the lock-order contract (§12) |
| 10 — refusal moves nothing | unchanged transaction semantics; logging is post-rollback (§9) |
| 11 — auditable | `record_audit_event` on every transition; append-only documents |

---

## 4. Workstream D1 — availability primitives

No behaviour change on its own: with no confirmation rows and an empty `1050`,
availability equals the booked balance for every account.

### 4.1 `cash_receipt_confirmations`

```
id                    uuid pk
journal_entry_id      uuid not null unique references journal_entries(id)
account_id            uuid not null references ledger_accounts(id)
branch_id             uuid not null references branches(id)
amount                bigint not null check (amount > 0)
state                 text not null          -- 'pending' | 'confirmed' | 'void'
source_type           text not null
recorded_by           uuid, recorded_by_label text not null
confirmed_by          uuid, confirmed_by_label text, confirmed_at timestamptz
void_reason           text
created_at, updated_at
```

Constraints: `confirmed` requires all three confirmer columns; `void` requires a
reason; **`confirmations_verifier_not_recorder` — `confirmed_by is null or
confirmed_by <> recorded_by`** (A-1); one row per journal entry;
`reject_mutation()` on DELETE; a column guard making `amount`, `account_id` and
`journal_entry_id` write-once.

### 4.2 Written by `post_journal`, and which inflows need confirmation

A single helper invoked from inside `post_journal`, over the lines it is handed
— one place instead of eight, covering paths added later, which a list of call
sites cannot promise. This is PR #25's argument for putting the lock in
`post_journal`, applied to the same problem.

| Inflow | Confirmation | Basis |
| --- | --- | --- |
| cash into a till | **pending until independently confirmed** | A-1 |
| MTN / Airtel into a wallet | **pending until independently verified, then immediately available** | A-3 |
| bank, a direct credit into a bank account | **pending until independently verified** | evidence-led, as a deposit is |
| a transfer between own accounts, a deposit, a clearance, a reversal, an agency posting | **none** | already inside the business and already controlled |

**A-3 is explicit about the gate:** verification releases the funds. Daily
reconciliation is not a precondition, is not consulted by
`cash_account_available_balance`, and no availability function reads
`account_reconciliations`. A test asserts this against a database that holds no
reconciliation row at all (§13.1).

### 4.3 Functions and views

| Object | Shape | Notes |
| --- | --- | --- |
| `cash_account_available_balance(uuid) returns bigint` | `stable`, definer, **no lock** | booked − pending for this one account. Reads no sibling account, no branch total, no reconciliation (A-3, A-5) |
| `assert_cash_funds_available(uuid, bigint)` | `volatile`, definer | `lock_ledger_balances(array[p_account_id])` **first**, then availability, then raise. **Takes no override argument and reads no override setting** (A-4) |
| `assert_spendable_account(uuid, text)` | `stable`, definer | refuses `in_transit`, `agency_float`, headings, inactive and non-cash accounts |
| `cash_account_availability` view | `security_invoker`, revoke-then-grant | `(account_id, branch_id, booked, pending_in, available)` — per account, with no aggregate column |
| `confirm_cash_receipt(uuid)` / `confirm_cash_receipts(uuid[])` | definer, `receipts:confirm` | A-1's second actor; locks the account (§12.4); batch form for counter throughput |
| `void_cash_confirmation(uuid, text)` | definer | for a receipt reversed before confirmation |

### 4.4 Settings — none

**v1 proposed three `finance_settings` columns. All three are removed.**

A-4 forbids a sufficient-funds override for anybody. A switch that made
unconfirmed or uncleared money available would be that override under another
name: `require_bank_clearance = false` relaxes rules 5 and 8 exactly as an
override would. So Decision A adds **no settings column**, and the rules are
unconditional.

`allow_negative_cash` and `allow_negative_agency_float` are left exactly as they
are and are **not read** by any function this plan adds. They continue to govern
the booked-overdraft question on the paths that already consult them, and
cannot reach availability. A test asserts that setting both to true does not
permit a short payout (§13.1).

### 4.5 What availability is not

- not a branch aggregate (A-5);
- not dependent on reconciliation (A-3);
- not stored in a column (ADR-052) — derived on every read, so a reversal moves
  every figure the instant it commits;
- not overridable (A-4).

---

## 5. Workstream D2 — universal enforcement and the selected funding account

### 5.1 Enforcement

Every path in §8 calls `assert_cash_funds_available`, which consults **one
account**: the one money is leaving. No path sums a branch, and no path falls
back to a sibling account when the named one is short (A-5). Paths that today
call `assert_cash_available` move onto the availability assert, so there is one
rule rather than two; `assert_cash_available` is retained unchanged for the
booked question and for `1050`, where booked and available are the same figure
by construction.

### 5.2 The selected funding account

`payment_method` does not identify an account. `branch_cash_account(branch,
kind)` resolves `order by a.code limit 1`, and
`ledger_accounts_one_wallet_per_branch` deliberately excludes `bank`, so a
branch may hold several bank accounts — meaning `payment_method = 'bank'`
silently pays from, and receives into, the alphabetically lowest-coded one.
Rules 1 and 2 are therefore unmet on the withdrawal and benefit paths as much as
on disbursement.

| Function | Change |
| --- | --- |
| `disburse_loan(p_loan_id)` | → `disburse_loan(p_loan_id, p_funding_account_id, p_branch_id default null)` |
| `post_savings_withdrawal(p_request_id, p_payment_method, p_external_reference, p_idempotency_key)` | → adds `p_funding_account_id` |
| `post_benefit_payment(p_claim_id, p_payment_method, p_external_reference, p_idempotency_key)` | → adds `p_funding_account_id` |

Validation on each: the account exists, is active and postable;
`assert_spendable_account`; it belongs to the document's branch; it is visible
under `user_can_see_branch`; and where a method is also given, its `cash_kind`
agrees with `payment_method_cash_kind(p_payment_method)`, so a receipt cannot
say "bank" over a till payment.

**Signature changes DROP then CREATE.** A defaulted parameter creates an
overload and PostgreSQL then refuses every call as ambiguous — the reason
recorded in `20261115001500` and `20261115000500`, both of which dropped and
recreated for exactly this. There are **no internal database callers** of the
three, so the surface is `lib/loans/actions.ts`, `lib/savings/actions.ts`,
`lib/benefits/actions.ts`, `types/database.types.ts` and the ADR-070 column
test. Each DROP restates its `revoke`/`grant` pair in the same migration.

### 5.3 Error correction, without an override

**The v1 Owner-only override is withdrawn.** This replaces it.

#### The problem it must solve

Four paths — `post_reversal_journal`, `reverse_savings_transaction`,
`reverse_membership_fee`, `reverse_meeting_fine_payment` — credit a cash account
for two incompatible reasons:

- a **refund**: value leaves the business, and rule 1 must apply;
- a **booking-error correction**: a receipt was recorded that never arrived, so
  the cash credit removes a fiction and value leaves nobody.

Under A-4 there is no override, so a correction cannot be forced through the
refund path. Under rule 11 the books must still be correctable, or a mis-keyed
receipt leaves a borrower permanently credited with money the business never
received.

#### The design

A **separate function**, `correct_misrecorded_receipt(p_journal_entry_id,
p_reason)`, which is structurally incapable of being a payout:

1. **It can only contra an entry it names, exactly.** Same accounts, same
   amounts, opposite sides, read from `journal_lines` — it accepts no amount, no
   account and no recipient. It cannot move value to anyone; it can only unwind
   a prior entry.
2. **It is refused on any entry whose `source_type` is an outflow** —
   disbursement, withdrawal, benefit payment, expense, transfer, deposit,
   clearance, or any `*_reversal` of those. Those are reversed through their own
   paths with sufficiency fully intact. It reaches inflow entries only.
3. **Maker-checker.** It requires a capability (`finance:correct`) and refuses
   the profile that recorded the original receipt, at the function layer and by
   a stored column pair, as every other second-actor rule here is enforced.
4. **A mandatory reason**, the full audit payload, and a notification.
5. **It hands off to reconciliation rather than to an override.** Where the
   contra takes the account's booked balance below zero, the account is flagged
   `requires_reconciliation`; while that flag stands, **every outgoing path from
   that account is refused** until a count has been submitted and approved,
   which is where `5950 Cash Over and Short` and the existing maker-checker
   already live. The shortfall is therefore surfaced and investigated, never
   spent.

No capability, argument or setting introduced here can make a short payout
succeed. The correction path cannot pay anybody, and the payout paths cannot
reach the correction path. That is what distinguishes this from the withdrawn
override, which widened the payout path itself.

#### Why `correct_misrecorded_receipt` is not simply refused when the till is short

Refusing it would leave the borrower's ledger wrong — showing a repayment the
business never received — which is a worse financial statement than a negative
till that is flagged, blocked from paying out, and queued for a count. The
plan's position is that a correction is not a payout and rule 1 is not engaged
by it, because no value leaves. **This is a business-policy judgement and is
flagged, not taken** (§15.2). If the Product Owner rules the other way, the
alternative is stated there.

---

## 6. Workstream D3 — Cash in Transit, bank clearance, bounced deposits

### 6.1 `1050 Cash in Transit`, and the three things that ship with it

One row per branch, `cash_kind = 'in_transit'`, asset, debit normal side,
code `1050-<branch>` (free: the existing cash accounts are `1010-`, `1020-`,
`1030-`, `1040-` suffixed, and no unsuffixed `1050` exists in the chart at the
PR #27 head).

A sixth `cash_kind` has three inseparable consequences, all of which happened
verbatim when Phase 4A added the fifth (`20261107000900`):

1. **`branch_cash_position` gains an `in_transit` component, in the same
   migration.** `total_liquidity` is `sum(balance) where cash_kind is not null`,
   so a sixth kind that is not also a named component makes the parts stop
   summing to the total — and two certified identities and three suites fail.
   **In-transit money stays inside `total_liquidity`:** it is an asset the
   business holds. The figure that excludes it is *available* funds, in its own
   columns.
2. **`assert_cash_account` is hardened to refuse `in_transit`, in the same
   migration.** That function tests only `cash_kind is null`, so the moment the
   kind is legal, Cash in Transit becomes a valid `record_transfer` endpoint —
   and `record_transfer` gates on `transfers:create`, which
   `secretary_treasurer` holds. A cashier could move money out of transit into a
   bank account with no clearance, no verifier, no evidence and no deposit
   record, posting `source_type = 'transfer'` so it never reaches the register.
   This is precisely the bypass Phase 4A closed for `agency_float` in the
   migration that created it: *"either without the other is a defect."*
3. **One `in_transit` account per branch**, added to
   `ledger_accounts_one_wallet_per_branch` or its own partial unique index, or
   `branch_cash_account(branch, 'in_transit')` repeats the arbitrary-pick defect
   of §5.2.

`scripts/certify-financial-reconciliation.mjs` must gain the component in its
sum identity — a certification-script change belonging to the implementation
phase.

### 6.2 `bank_deposits`

```
id, deposit_number                 -- next_reference('bank_deposit')
branch_id, from_account_id         -- the till
transit_account_id                 -- 1050 for that branch
bank_account_id                    -- cash_kind = 'bank', same branch
amount                             -- > 0
deposit_date                       -- business_date() at recording
status                             -- 'submitted' | 'cleared' | 'rejected'
                                   -- | 'under_investigation' | 'reversed'
bank_reference, cleared_on, deposit_slip_path, clearance_notes
investigation_opened_at / _by / _reason
investigation_outcome, investigation_closed_at / _by
recorded_by / _label
verified_by / _label / verified_at
decision_reason
deposit_journal_entry_id    uuid unique   -- till -> 1050, at recording
clearance_journal_entry_id  uuid unique   -- 1050 -> bank, at verification
reversal_entry_id           uuid unique
idempotency_key             uuid not null unique
created_at, updated_at
```

`written_off` is **absent** from the status domain: see §6.6.

Constraints: amount positive; the three accounts distinct and in the same
branch; `(status <> 'rejected') = (deposit_journal_entry_id is not null)`;
`(status = 'cleared') = (clearance_journal_entry_id is not null)`;
**`bank_deposits_verifier_not_recorder`** — `verified_by is null or verified_by
<> recorded_by`; when `cleared`, `bank_reference` non-blank and `cleared_on`,
`verified_by`, `verified_at` present; `cleared_on >= deposit_date` and
`cleared_on <= business_date()` (A-6, §6.5); rejection, investigation and
reversal each require a reason; `reject_mutation()` on DELETE and a column guard
making the evidence write-once.

### 6.3 The functions

| Function | Capability | Behaviour |
| --- | --- | --- |
| `record_bank_deposit(from_account, bank_account, amount, deposit_date, description, idempotency_key, branch_id default null)` | `deposits:create` | advisory lock on the key, replay returns the row; branch per §10; `assert_cash_funds_available(till, amount)` — a deposit **is** an outgoing path; posts Dr `1050` / Cr till; `submitted` |
| `verify_bank_deposit(deposit_id, bank_reference, cleared_on, slip_path, notes)` | `deposits:verify` | `for update`; idempotent if already `cleared`; **refuses `recorded_by = current_profile_id()` with `42501`**; `user_can_see_branch`; evidence validated; `assert_cash_available(transit, amount)`; **full amount only** (A-7); posts Dr bank / Cr `1050` dated `business_date()` (§6.5); `cleared` |
| `reject_bank_deposit(deposit_id, reason)` | `deposits:verify` | only from `submitted`; distinct-actor; contra of the deposit entry; money returns to the till; `rejected` |
| `open_deposit_investigation(deposit_id, reason)` | `deposits:verify` | from `submitted` or `cleared`; **posts nothing** — the money stays where it is while the question is open (A-8) |
| `close_deposit_investigation(deposit_id, outcome, reason, …)` | `deposits:verify` | two outcomes only; §6.6 |
| `reverse_bank_deposit_clearance(deposit_id, reason)` | **`deposits:reverse` — Owner only** | only from `cleared`; `assert_cash_available(bank, amount)` — the bank must still hold it, as `reverse_transfer` already requires; **refuses the person who verified it** (A-9); contra of the *clearance* entry only, returning the money to `1050`; status back to `submitted` with evidence cleared and preserved in audit; stamps `reversed_by_entry_id` |

**A-9 needs both halves.** "Owner only" is a capability granted to
`owner_admin` alone. "With separation of duties" is a row-level rule, because an
Owner also holds `deposits:verify` and could otherwise verify a deposit and then
reverse their own verification. Both are enforced, and the verifier-reversal
refusal is CHECK-backed so it cannot be forgotten.

### 6.4 A deposit is itself an outgoing path

`record_bank_deposit` draws on the till, so it obeys rule 1 like any other
outflow — and under A-4 with no override. A branch cannot deposit money it has
not confirmed.

### 6.5 A-6 — two dates, deliberately separated

v1 conflated them. They are now distinct:

| Date | Meaning | Rule |
| --- | --- | --- |
| `cleared_on` | the **bank's value date**, stored as evidence | **may be historical.** Bounded only by `>= deposit_date` and `<= business_date()` |
| the clearance journal's `entry_date` | the **accounting date** | always `business_date()`. **Never** `cleared_on`, and never backdated |

So a bank credit dated three days ago is recorded faithfully as evidence, and
the accounting entry lands in today's open period. Nothing this plan adds can
post into a past period, which satisfies A-6 **without** requiring a
period-close subsystem.

**That subsystem does not exist, and A-6 implies it.** There is no
`financial_period` table, no period lock, no close or reopen function, and no
constraint on `journal_entries.entry_date` anywhere in the 214-migration schema;
the column's own comment records that *"a back-dated correction posts to the day
it happened"* — backdating is a designed property of this ledger. Three existing
paths already accept an unbounded date from the caller:
`record_transfer(p_transfer_date)`, `record_expense(p_expense_date)` and
`record_other_income(p_income_date)`, each `coalesce`d to `business_date()` with
no bound in either direction. Enforcing A-6 across the system therefore means
building period close and guarding every posting path, which is larger than
Decision A and affects paths Decision A does not touch. **Flagged as a new
requirement, not built here** (§15.1).

### 6.6 Bounced-deposit investigation (A-8), with the write-off parked

An investigation holds the money in `1050` and posts nothing until it closes.
**Two outcomes are in scope:**

| Outcome | Posting | Status |
| --- | --- | --- |
| `recovered` | the normal clearance, Dr bank / Cr `1050`, with evidence, dated today | `cleared` |
| `returned_to_till` | contra of the deposit entry, Dr till / Cr `1050` | `rejected` |

**The write-off outcome is removed from this plan and referred for separate
review**, on the Product Owner's instruction. Two notes for that review:

- v1 proposed `5960 Deposit Losses Under Investigation`. **That code is already
  taken** — `5960 Agency Float Over and Short` exists at the PR #27 head. So
  does `5970 Agency Float Purchase Premium`. A new code must be chosen against
  the chart as it will then stand.
- A write-off decides who bears a loss, which is why it is not merely a chart
  question. Whether the shortfall becomes an expense or a receivable naming an
  individual is an HR-sensitive policy matter and belongs with that review.

Until it is decided, a deposit that is neither recovered nor returnable stays
`under_investigation` indefinitely, with the money visible in `1050` and an
ageing report. That is an honest interim state: nothing is written off by
default and nothing is hidden.

### 6.7 A-13 — one word, two contexts

`bank_deposits.status = 'cleared'` and `loans.status = 'cleared'` are **both
correct and both retained.** A deposit that the bank has honoured is cleared; a
loan that owes nothing is cleared. The word is right in each context and
renaming either would make one of them read oddly to the people who use it.

The collision is managed by keeping the contexts separate, which the schema
already does and which this plan does not weaken:

- two independent `text` columns with their own CHECK constraints — no shared
  enum, no shared domain, no shared lookup table;
- no view, report or function reads a bare `cleared` across both subjects;
  deposit registers and loan registers are separate objects;
- user-facing labels are qualified — "Deposit cleared", "Loan cleared" — in
  every screen, export and notification;
- a test asserts that clearing a deposit alters no loan's status and that
  clearing a loan alters no deposit's status (§13.1).

This reverses the gap analysis D14 recommendation, which proposed avoiding the
word for deposits.

---

## 7. Workstream D4 — receipt confirmation without double-posting

A-10 decides the design. Three options were considered; the schema admits one.

| Option | Verdict |
| --- | --- |
| Post the journal at **verification** instead of receipt | **Refused.** `loan_payments.status` would need a third value, which `loan_payments_guard_mutation` refuses outright; and `loan_balances`, `loan_installment_coverage` and `payment_collection_totals` all filter `status = 'posted'`, so every borrower's arrears, coverage, delinquency state and loan clearance would change because the business had not yet counted its drawer |
| Post to a **holding account** at receipt, transfer to the till on confirmation | **Refused.** Two journals per receipt — the double-posting A-10 forbids — and it misstates where the cash physically is, so the daily count stops agreeing with the till |
| **One journal at receipt, plus a restriction record** | **Adopted** (§4.1) |

`post_payment`, `post_savings_deposit`, `record_membership_fee`,
`post_meeting_fine_payment` and `record_other_income` are **unchanged**. Each
writes exactly one journal, at receipt, debiting the real cash account.
`post_journal` additionally writes a `pending` confirmation row, which deducts
from availability and from nothing else.

Preserved, and asserted: one journal per receipt; `loan_payments.status =
'posted'` at receipt so every balance view, arrears figure, delinquency state
and loan clearance is **bit-identical** to today; the `1200`, `4100` and `2100`
identities; `loan_payments_guard_mutation` and the `payment_allocations`
no-update rule.

Confirmation is the second actor's act (A-1), refuses the recorder at both
layers, locks the account, and records both names. A receipt reversed before
confirmation voids its pending row rather than leaving a deduction against money
no longer booked.

---

## 8. The complete outgoing-path inventory

A-2 is universal, so the inventory must be complete. Every function at the
PR #27 head that credits a cash-kinded account:

| # | Function | Entry point | Credits | Today | After |
| --- | --- | --- | --- | --- | --- |
| 1 | `post_disbursement_journal` | `disburse_loan` | branch till | **none** | availability |
| 2 | `post_savings_withdrawal` | same | branch cash | **none** | availability |
| 3 | `post_benefit_payment` | same | branch cash | **none** | availability |
| 4 | `post_reversal_journal` | `reverse_payment` | branch cash | **none** | availability; correction via §5.3 |
| 5 | `reverse_savings_transaction` | same | original cash account | **none** | availability; correction via §5.3 |
| 6 | `reverse_membership_fee` | same | receiving account | **none** | availability; correction via §5.3 |
| 7 | `reverse_meeting_fine_payment` | same | fine's cash account | **none** | availability; correction via §5.3 |
| 8 | `approve_reconciliation` (lending, shortage) | same | counted account | **none** | availability + `lock_ledger_balances`, matching its agency twin |
| 9–20 | `post_transfer_journal`, `reverse_transfer`, `post_expense_journal`, `reverse_other_income`, `post_agency_transaction`, `reverse_agency_transaction`, `post_agency_payable_settlement`, `post_float_replenishment`, `approve_agency_cash_reconciliation`, `approve_agency_float_reconciliation`, `reverse_commission_settlement`, `verify_agency_float_trade` / `reverse_agency_float_trade` | various | various | `assert_cash_available` / float assert | availability |
| **21** | **`record_bank_deposit`** | new | branch till | — | availability |
| **22** | **`verify_bank_deposit`** | new | `1050` | — | `assert_cash_available` on transit |

Paths 4–8 were absent from PR #25's reported set of three, because that
inventory was read from the source types present in the seeded book, and a
membership-fee refund, a meeting-fine refund and a lending shortage write-off
were not in it.

---

## 9. Workstream D6 — nonfinancial refusal-audit logging

### 9.1 It cannot be done inside the database

Rule 10 refuses by aborting the transaction, and the abort takes any log row
with it. The in-database answer would be an autonomous transaction, and this
deployment has no mechanism for one: the only installed extension is `pg_trgm`.
No `dblink`, no `pg_background`, no `pg_cron`.

### 9.2 The design

1. The server action calls the payout RPC. It fails.
2. The action catches the failure and calls `log_refused_financial_action(...)`
   on a **new** transaction, with the classification, the document, the account,
   the requested amount, the SQLSTATE and the actor's own session.
3. The row lands in `refused_financial_actions`. The refusal stands whatever
   happens at step 3.

### 9.3 The four properties that keep it from bypassing financial controls

1. **It can write nothing financial.** `SECURITY DEFINER` over one table,
   `execute` granted to `authenticated` alone, and granted nothing on
   `journal_entries`, `journal_lines` or any document table. No `post_journal`
   call, no status write.
2. **Its output is never an input.** No authorization, sufficiency, approval,
   confirmation, clearance or correction decision reads
   `refused_financial_actions`. A refusal cannot be logged and then cited to
   obtain anything — and under A-4 there is nothing to obtain.
3. **Logging failure is not success.** The refusal is returned to the user
   whether or not the log write succeeded. A logging outage degrades evidence,
   never control.
4. **It is not a side channel.** Actor from the session, never a parameter; no
   foreign key that could be probed for rows the caller may not read; `select`
   gated on `audit:view_refusals`; writes rate-limited per actor through the
   existing `rate_limit_counters`.

Append-only (`reject_mutation()` on UPDATE and DELETE), with a register view,
and carrying no amount that could be mistaken for a posting — it records the
*request*, which is why the deliverable is nonfinancial.

---

## 10. Workstream D5 — branch-scoped finance access and Head Office selection

### 10.1 Reuse the operating-branch rule

PR #27's `20261115001500_agency_operating_branch.sql` already settles this, and
records why guessing is worse than refusing: `create_agency_transaction` fell
back to the alphabetically first active branch, right by accident with one
branch and misrouting five counter tests the moment a second existed. Head
Office is exactly the affected officer — the Owner and the Secretary both carry
`profiles.branch_id = null`.

The rule, called rather than re-derived: *a branch-less officer names the
operating branch, a branch-assigned officer records at their own and may name no
other, the branch is validated against what the officer may see, and it must be
open.* `p_branch_id uuid default null` goes **last**, so every positional call by
a branch-assigned officer stays valid. This makes PR #27 a hard dependency.

### 10.2 Close the two branch gaps (A-12)

- **Write paths.** `user_can_see_branch` added to `record_transfer`,
  `approve_transfer`, `reject_transfer`, `reverse_transfer`, the three expense
  functions, `record_other_income`, `reverse_other_income`,
  `submit_reconciliation`, `approve_reconciliation`, `disburse_loan`,
  `post_payment` and `reverse_payment`.
- **Read policies.** A branch predicate added to the `journal_entries`,
  `journal_lines` and `ledger_accounts` select policies, which today have none.
  Every `profiles.branch_id` is currently null — unrestricted — so the
  observable blast radius is nil today and grows with the first branch
  assignment.

### 10.3 Capabilities

| Capability | `secretary_treasurer` | `manager` | `owner_admin` |
| --- | --- | --- | --- |
| `deposits:view` | ✓ | ✓ | ✓ |
| `deposits:create` | ✓ | ✓ | ✓ |
| `deposits:verify` | | ✓ | ✓ |
| `deposits:reverse` | | | ✓ |
| `receipts:confirm` | | ✓ | ✓ |
| `finance:correct` | | ✓ | ✓ |
| `audit:view_refusals` | | ✓ | ✓ |

No capability here overrides sufficiency; none can (A-4). The distinct-actor
rules do the real work, because `manager` and `owner_admin` necessarily hold
both sides of several pairs.

---

## 11. Migration order and safety

### 11.1 Branch point

| Candidate | Verdict |
| --- | --- |
| Audited base `64ea09c` (161) | **No.** No `lock_ledger_balances`, no `post_journal` lock |
| PR #25 head (194) | **No.** Has the locking, not the operating-branch rule A-12 needs |
| **PR #27 head (214)** | **Yes.** Carries both |

Migrations are dated **after `20261115001600`**, so the stack is never
re-ordered. PRs #26 and #27 redefine **none** of `post_journal`,
`assert_cash_available`, `lock_ledger_balances`, `disburse_loan`, `post_payment`,
`post_reversal_journal`, `post_savings_withdrawal` or `post_benefit_payment`, so
Decision A's changes are conflict-free against both. `branch_cash_position` was
last redefined by `20261107000900`; extend **that** version.

### 11.2 Order

| Step | Migration | Must precede |
| --- | --- | --- |
| 1 | `cash_receipt_confirmations`, availability functions and view, `assert_spendable_account`. **No settings column** | everything |
| 2 | `in_transit` kind **+** `branch_cash_position` component **+** `assert_cash_account` hardening **+** uniqueness index — **one indivisible migration** | any `1050` row |
| 3 | `1050-<branch>` chart rows, idempotently, including for branches created later | the deposit document |
| 4 | the four new `source_type` values, the `bank_deposit` reference scope, the new capabilities | the deposit functions |
| 5 | `bank_deposits` + its six functions | the UI |
| 6 | `assert_cash_funds_available` wired into paths 1–8; the DROP/CREATE signature changes; `correct_misrecorded_receipt`; the `requires_reconciliation` flag and its payout block | the UI |
| 7 | paths 9–20 moved onto the availability assert | — |
| 8 | branch predicates on the write paths and the ledger read policies | — |
| 9 | `refused_financial_actions` + its RPC | the server actions |

Step 2 is indivisible for the reason Phase 4A gave about `agency_float`: one
half breaks the certified identities, the other opens a bypass of the control
being built.

### 11.3 Historical accounting is preserved by construction

Both halves are built so that **the absence of a record means available**: no
historical inflow has a confirmation row, so none is deducted; `1050` opens at
zero and is only ever credited by clearances of deposits recorded after cutover.

At cutover **every existing balance is available in full: no row is written, no
journal is posted, no figure moves.** A backfill of confirmation rows, or
re-posting historical deposits through `1050`, is refused.

Specifically protected: the derived opening entry of **21,449,163** and the
assertion that Cash at Hand touches exactly zero at its lowest historical point;
`journal_entries_guard_update`, which is why clearance state lives on its own
table; and every existing migration, neither edited, renamed nor re-ordered.

### 11.4 Mechanics

`ledger_accounts_cash_kind_valid` and `journal_entries_source_valid` are widened
by drop-and-recreate, repeating existing values verbatim — and **their live
names are queried before the DDL is written**, because Phase 4A found the
architecture specification had both constraint names wrong and would have
aborted if transcribed. New columns are registered in
`tests/db/postgrest-columns.test.ts` (ADR-070) and types regenerated with
`npm run db:types`. **No feature flag and no settings column**: §11.3 makes the
transition a no-op, and under A-4 a flag would be an override.

**No migration is applied to production.** The release gates' existing blockers
— including the Git-linked Supabase branch reporting `MIGRATIONS_FAILED` — are
independent of this work.

---

## 12. Concurrency and the lock-order contract

1. **The global order is unchanged:** provider lock → account locks (sorted) →
   reference counter. New paths acquire account locks only through
   `lock_ledger_balances`, which sorts, de-duplicates and drops nulls.
2. **Availability is computed under the lock, after it** — the construction
   `20261109000100` chose, so a waiting transaction sees the committed result of
   the one it waited for.
3. **Multi-account postings lock up front, together.** A clearance touches
   `1050` and the bank account; an investigation close may touch `1050` and the
   till. Both before the sufficiency check, in sorted order, because PR #25's
   transfer fix showed that holding an out-of-order subset is what deadlocks
   once `post_journal` locks the whole entry.
4. **Confirmation locks the account it makes available**, or a payout can be
   decided against a stale availability read.
5. **Nothing is cached** (ADR-052).
6. **Idempotency on every new write path:** `idempotency_key uuid not null
   unique`, advisory lock on the key first, authorization **above** the replay
   shortcut (ADR-056), verification idempotent on an already-cleared deposit.

---

## 13. Exact tests for each critical financial control

Every case below is a named test. The matrix in §2 maps each decision to its
case.

### 13.1 PostgreSQL (`tests/db/`, `vitest --project db`)

**`cash-sufficiency.test.ts`** — control: rule 1 under A-2 and A-4.
- `refuses path <n> when the funding account is short` — **ten cases**, one per
  path 1–8, 21, 22.
- `a refusal writes no journal, line, document or status` — per path.
- `refuses when booked is sufficient but available is not`.
- `permits once the receipt is confirmed`.
- `permits once the deposit is cleared`.
- `no actor, Owner included, can post a short payout` — asserts there is no
  capability, argument or setting that succeeds (A-4).
- `allow_negative_cash and allow_negative_agency_float do not relax availability`.
- `refuses 1050 as a funding account` — per path.
- `refuses a funding account from another branch`.

**`cash-availability.test.ts`** — control: the availability definition.
- `available equals booked minus pending`.
- `a pending receipt does not raise availability`.
- `verified wallet float is available before any reconciliation exists` — run on
  a database holding **no** `account_reconciliations` row (A-3).
- `no availability function reads account_reconciliations` — asserted by
  inspecting the function bodies.
- `a sibling account's balance never funds this one` (A-5).
- `no availability function consults a branch total` (A-5).
- `no confirmation row means fully available` — against the demo book; the
  mechanical proof that history did not move.
- `reversing a pending receipt voids its deduction`.
- `in-transit money is inside total_liquidity and outside available`.

**`receipt-confirmation.test.ts`** — control: A-1 and A-10.
- `loan figures are identical before and after confirmation` — `loan_balances`,
  `loan_installment_coverage`, `payment_collection_totals`, arrears,
  delinquency state and loan clearance compared to pre-change snapshots.
- `a receipt writes exactly one journal`.
- `confirmation writes no journal`.
- `refuses the recorder as confirmer, at both layers` — the function raise and a
  direct `UPDATE` as `service_role`.
- `batch confirmation is atomic`.
- `loan_payments.status is posted at receipt and never anything else`.

**`bank-clearance.test.ts`** — control: rules 5, 6, 7 and A-6, A-7, A-9, A-13.
- `refuses a clearance for less than the deposit` (A-7).
- `requires a bank reference, a value date and a verifier`.
- `a historical value date posts to today, never to the value date` (A-6).
- `refuses a value date before the deposit date`.
- `refuses a value date in the future`.
- `the verifier cannot be the recorder` — function **and** CHECK.
- `the verifier cannot reverse their own clearance` (A-9).
- `only an Owner may reverse a clearance` (A-9).
- `refuses a second clearance of one deposit` — via
  `journal_entries_one_per_source`.
- `a clearance reversal returns money to transit, not to the till`.
- `refuses a clearance reversal when the bank no longer holds it`.
- `refuses a transfer out of 1050` — the §6.1.2 bypass.
- `deposit clearance does not alter any loan status` (A-13).
- `loan clearance does not alter any deposit status` (A-13).
- `a deposit is refused when the till is short` (§6.4).

**`deposit-investigation.test.ts`** — control: A-8.
- `opening an investigation writes no journal`.
- `recovered posts the clearance and nothing else`.
- `returned_to_till posts the deposit contra and nothing else`.
- `refuses an outcome from the wrong state`.
- `a write-off outcome does not exist` — asserts the status domain and the
  function signature, so the parked decision cannot be used by accident (§6.6).

**`receipt-correction.test.ts`** — control: §5.3.
- `corrects only the entry it names, line for line`.
- `refuses any outflow source type` — disbursement, withdrawal, benefit,
  expense, transfer, deposit, clearance and their reversals.
- `refuses the person who recorded the original receipt`.
- `requires finance:correct and a reason`.
- `flags the account as requires_reconciliation when the contra goes below zero`.
- `every outgoing path from a flagged account is refused` — per path.
- `an approved count clears the flag`.
- `the correction path cannot pay anybody` — asserts no cash leg other than the
  exact contra, and no recipient argument.

**`cash-sufficiency-concurrency.test.ts`** — control: rule 9.
- Real parallel connections, extending PR #25's harness: two disbursements each
  affordable alone; disbursement versus withdrawal; disbursement versus benefit;
  benefit versus withdrawal; payment reversal versus disbursement; a payout
  racing a clearance; a payout racing a confirmation; two verifications of one
  deposit; a correction racing a payout; and the lock-order deadlock probe over
  `1050` + bank in opposing orders.
- Each case holds **only** the account's advisory lock, posts nothing and takes
  no reference, and distinguishes *refused* from *walked past* — because
  `next_reference('journal')` serialises every posting until commit and makes
  outcome-based races pass by accident.

**`refusal-audit.test.ts`** — control: A-11 and rule 10.
- `a refused payout leaves a log row and no financial row`.
- `the logging RPC cannot write a journal`.
- `a logging failure still refuses the payout`.
- `the log is append-only`.
- `rate limiting applies per actor`.
- `no financial function reads refused_financial_actions`.

**`rls-deposits.test.ts`** — control: A-12.
- `anon is denied on every new table and view`.
- `no INSERT, UPDATE or DELETE grant exists`.
- `a branch-scoped profile sees only its branch`.
- `a branch-scoped profile cannot fund from another branch`.
- `the ledger read predicate scopes journal entries, lines and accounts`.
- `refused_financial_actions requires audit:view_refusals`.

**Identity and regression.**
- `trial_balance foots`; `1050 equals the sum of submitted and
  under-investigation deposits`; the `1200`, `4100`, `2100` identities;
  `total_liquidity equals its six named components`;
  `total_liquidity equals every GL account with a cash_kind`;
  `the opening entry is 21,449,163 and the till still touches zero`.
- **Every existing suite passes unchanged** — the evidence this is additive.

### 13.2 Integration (`vitest --project integration`)

Friendly refusal messages, never a raw SQLSTATE; funding-account and branch
arguments validated and safely rejected when absent, malformed or invisible;
rate limiting intact on disbursement; `revalidatePath` covering the finance,
loan, savings and benefit routes a clearance changes; the refusal-log call fired
on failure and swallowed on its own failure; `audit:money` over new money
TypeScript.

### 13.3 Browser (Playwright, `tests/e2e/specs/`)

`bank-deposits.write.spec.ts` — record, see it excluded from available funds,
verify as a **second** user, see the first user's verify attempt refused, and an
Owner-only reversal refused for the verifier.
`cash-sufficiency.write.spec.ts` — a funding-account picker showing **available**
balances per account, not one aggregated bank figure; submit blocked when short;
the server still refusing when the form is bypassed; the same on the withdrawal
and benefit screens; a Head Office officer prompted to name the operating
branch and a branch-assigned officer not offered another.
`receipt-confirmation.write.spec.ts` — a receipt visible as unconfirmed,
confirmable only by a second user. Plus: no screen presenting aggregated
liquidity as spendable; deposit and loan clearance labelled distinctly (A-13);
no partial state after a refusal and reload; an `@axe-core/playwright` pass on
every new screen.

### 13.4 Certification

`npm run verify`, `npm run test:db`, `npm run audit:money`, the database
security gate, `scripts/certify-financial-reconciliation.mjs` **with its sum
identity extended for `in_transit`**, the historical migration replay with
identical figures, and the new-head required CI.

---

## 14. The invariant register

| Invariant | Where asserted |
| --- | --- |
| Every journal balances; every entry has ≥ 2 lines | deferred constraint triggers |
| One journal per `(source_type, source_id)` | `journal_entries_one_per_source` |
| The ledger is append-only; one mutable column on an entry | `journal_lines` triggers, `journal_entries_guard_update` |
| `trial_balance` foots; it equals the journal | certification identities |
| `total_liquidity` = sum of its **six** named components | certification identity, **to extend** |
| `total_liquidity` = every GL account with a `cash_kind` | certification identity |
| `1200` = `principal_outstanding`; `4100` = interest collected; `2100` = `sum(signed_amount)` | certification identities, savings suites |
| Loan figures unchanged by confirmation | `receipt-confirmation.test.ts` |
| `loan_payments` admits exactly one status transition | `loan_payments_guard_mutation` |
| Opening entry = 21,449,163; till touches zero | ledger suite |
| A refused payout writes nothing financial | `cash-sufficiency.test.ts` |
| **No actor or setting can override sufficiency** | `cash-sufficiency.test.ts` (A-4) |
| **Availability reads one account, never an aggregate or a reconciliation** | `cash-availability.test.ts` (A-3, A-5) |
| **No accounting entry is dated earlier than today** | `bank-clearance.test.ts` (A-6, within this plan's scope) |
| No cash-kinded account is reachable by a generic transfer unless spendable | `assert_cash_account`, `bank-clearance.test.ts` |
| Availability is derived, never stored | code review + ADR-052 |

---

## 15. Genuinely unresolved decisions

Flagged rather than taken.

1. **Closed accounting periods do not exist** (§6.5). A-6 forbids backdating
   into a closed period, and the schema has no period, no close, no reopen and
   no `entry_date` guard; three existing paths already accept an unbounded date.
   This plan satisfies A-6 inside its own scope by never backdating at all, but
   enforcing A-6 **system-wide requires a period-close subsystem** touching
   every posting path. Needs: what closes (month? arbitrary range?), who closes
   and reopens, hard lock or soft warning, and what happens to the three
   existing unbounded-date paths. **Recommended as its own workstream.**
2. **Is a booking-error correction a payout?** (§5.3). This plan's position is
   that it is not — no value leaves, so rule 1 is not engaged, and the resulting
   negative booked balance is flagged, blocked from paying out, and queued for a
   count. The alternative is to refuse the correction until the account is
   funded, which leaves the borrower's ledger showing a repayment the business
   never received. **The Product Owner should choose knowingly.**
3. **The second authorizer for a correction** — this plan refuses the original
   recorder and requires `finance:correct`. Confirm the capability holders, and
   whether a Manager correcting a Manager's receipt is sufficient separation.
4. **Who clears a `requires_reconciliation` flag**, and whether a flagged
   account blocks inbound receipts as well as payouts. This plan blocks only
   outgoing paths.
5. **The deposit-loss account and write-off procedure** — referred for separate
   review (§6.6). Note that `5960` and `5970` are already taken, and that the
   choice between an expense and a receivable naming an individual is
   HR-sensitive.
6. **Indefinite `under_investigation` deposits** — with the write-off parked,
   what is the ageing threshold at which an unresolved deposit is escalated, and
   to whom?
7. **Confirmation throughput for physical cash** (A-1). Per-receipt confirmation
   by a second person is implemented; confirm the batch-confirm granularity
   (per till session? per day?) that operations needs.
8. **Does a `pending` receipt affect anything beyond availability?** This plan
   says no — loan book, savings qualification, member-loan capacity and benefit
   eligibility are untouched (A-10 for the loan book; the rest by extension).
   Confirm for savings and benefits explicitly.
9. **Four new ADRs** are implied, from ADR-072: availability as a restriction
   rather than a second ledger; Cash in Transit for bank deposits and not for
   till cash; confirmation off the receipt row; refusal audit outside the
   financial transaction. The first supersedes the settlement-status note at the
   head of `20261020000400`. A fifth would record A-13's two-context `cleared`.
