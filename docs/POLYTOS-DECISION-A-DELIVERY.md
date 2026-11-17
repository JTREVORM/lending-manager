# POLYTOS — Decision A delivered: no unfunded payouts

**Authorization:** the Owner's decision of 2026-11-16, *"POLYTOS — Owner
decision on DEFECT-001 and GAP-001"*, Decision 2: **APPROVED: NO UNFUNDED
PAYOUTS**, with eleven numbered instructions.

**Branch:** `claude/keen-dirac-2nptar`. **Not merged. Not deployed. No
production migration applied.**

**What this closes:** GAP-001 of
`docs/POLYTOS-FULL-SYSTEM-BUSINESS-RULES-CERTIFICATION.md` — three money-out
paths that never checked whether the cash existed, reproduced live at a branch
till of **−345,000** with `allow_negative_cash = false`.

---

## 1. The finding, and why it survived so long

`assert_cash_available` has always been correct: it reads
`allow_negative_cash` itself, so no caller could opt out. The defect was never
in the check. It was in which callers reached it.

| Money-out path | Checked the cash before 2026-11-16? |
| --- | --- |
| `post_transfer_journal`, `reverse_transfer` | yes |
| `post_expense_journal`, `reverse_other_income` | yes |
| `post_agency_transaction`, `reverse_agency_transaction` | yes |
| **`disburse_loan` / `post_disbursement_journal`** | **no** |
| **`post_savings_withdrawal`** | **no** — it checked the *member's* balance under lock, three ways, and the company's till not at all |
| **`post_benefit_payment`** | **no** |

And the certification harness could not see it. Its 38 identities included
"no loan reports a negative outstanding" and "no savings account holds a
negative balance" — and **no identity for cash**. Its three cash identities
ask whether the views agree with the general ledger, and they agree perfectly
well when the ledger says minus three hundred and forty-five thousand. The
harness checked consistency, never plausibility.

---

## 2. What was built

Four migrations, in order. Each is additive: no applied migration was edited,
no historical journal re-posted, no balance reclassified.

### `20261120000100_cash_availability.sql` — available funds

The model is a **restriction**, not a second ledger:

```
available = booked − receipts nobody has confirmed
```

Both terms are derived on demand; nothing is cached (ADR-052). A receipt is
posted exactly as before — one journal, at receipt, to the real cash account,
on the real date — so **every borrower figure is bit-identical**: arrears,
delinquency state, installment coverage, loan clearance, the `1200`, `4100`
and `2100` identities. What changes is only what the *company* may spend.

| Object | What it is |
| --- | --- |
| `cash_receipt_confirmations` | one row per cash line of a receipt journal, `pending` until a different officer confirms it |
| `receipt_requires_confirmation(text)` | the allowlist: loan repayment, savings deposit, membership fee, other income (meeting fines post under it) |
| `register_receipt_restrictions(...)` | called from inside `post_journal`, over the lines just written — one place, so a receipt path added later is covered by construction |
| `cash_account_available_balance(uuid)` | booked less pending, for **one** account. Reads no sibling, no branch total, no reconciliation |
| `assert_cash_funds_available(uuid, bigint)` | lock first, read after, raise if short. No override argument, no override setting |
| `assert_spendable_account(uuid, text)` | refuses agency float, Cash in Transit, headings, inactive and non-cash accounts |
| `cash_account_availability` | the read surface: booked, pending, available, per account. **No aggregate column** |
| `confirm_cash_receipt` / `confirm_cash_receipts` | the second officer, singly or over a drawer |

`assert_cash_available` keeps its name and now means *available* funds, so
every existing caller gained the rule without being edited — and none could be
missed. `finance_settings.allow_negative_cash` is read by nothing; its column
comment says **INERT** and a test asserts that comment exists.

### `20261120000200_cash_in_transit.sql` — the sixth cash kind

One indivisible migration, for the reason Phase 4A gave when it added the
fifth:

1. `1050-<branch> Cash in Transit`, one per branch, enforced by a partial
   unique index;
2. `branch_cash_position` gains its `in_transit` component **in the same
   migration**, or the six parts stop summing to `total_liquidity` and two
   certified identities fail;
3. `assert_cash_account` refuses `in_transit` **in the same migration**, or
   the moment the kind is legal a plain transfer can move it — and
   `transfers:create` is a cashier's capability.

### `20261120000300_bank_deposits.sql` — clearance, and the second officer

| Function | Posting | Who |
| --- | --- | --- |
| `record_bank_deposit` | till → `1050` | `deposits:create`; a deposit **is** an outgoing path, so it needs available funds |
| `verify_bank_deposit` | `1050` → bank | `deposits:verify`, **never the recorder**; full amount only; dated **today**, never the bank's value date |
| `open_deposit_investigation` | **nothing** | the money stays in transit, where it honestly is |
| `confirm_physical_cash_return` | `1050` → till | only on independently verified physical receipt |
| `reverse_bank_clearance` | bank → `1050` | **Owner only**, never the original verifier, and the bank must hold it as *available* |

Three dates are kept apart: `bank_value_date` is the bank's evidence and may
be historical; `verified_at` is the actor event; the journal's `entry_date` is
always `business_date()`. **Nothing here can post into a past period.**

### `20261120000400_no_unfunded_payouts.sql` — making it bind

Two mechanisms, deliberately independent:

1. **Each path asks, by name.** `disburse_loan`, `post_savings_withdrawal`,
   `post_benefit_payment` and the five receipt-reversal paths now call
   `assert_cash_funds_available` or `release_or_assert_receipt_reversal` on
   the one account money leaves. This produces a refusal naming the account
   and the shortfall.
2. **The storage layer refuses anyway.** `journal_lines_assert_funded` is a
   **deferred** constraint trigger: at commit, any line that took money out of
   a till, wallet, bank or transit account must leave that account's available
   balance at or above zero. It binds `service_role`, a hand-written INSERT,
   and every posting path written after today — which a list of functions
   cannot promise.

Agency float is excluded from the trigger: it keeps `assert_agency_float_available`
and `allow_negative_agency_float`, which the Owner's instruction 2 expressly
preserves. Two rules over one balance would be two answers to one question.

`disburse_loan` also gains an optional funding account. Passing nothing keeps
today's behaviour — the branch till — so no existing caller changed; passing
one disburses from it, after checking it is a spendable account **of the
loan's own branch** (instruction 3: no cross-branch pooling).

---

## 3. The Owner's eleven instructions, point by point

| # | Instruction | Where |
| --- | --- | --- |
| 1 | Disbursement, savings-withdrawal payout and benefit payment check the selected funding account | part 4 §1–2; `cash-sufficiency.test.ts` |
| 2 | Extended to other money-out operations, preserving provider float and payable rules | `assert_cash_available` redefined, so transfers, expenses, income and agency inherit it; float keeps its own rule |
| 3 | Independent available balance per account; no pooling across accounts or branches | `cash_account_available_balance` reads one account; the view has no total; `post_disbursement_journal` refuses another branch's account |
| 4 | A short payout is refused **before any posting is committed** | the check raises before `post_journal`; the trigger is deferred and aborts the transaction. Asserted: no entry, no line, no schedule, no status change |
| 5 | `allow_negative_cash` cannot bypass it | nothing reads it; the column is commented INERT; a test turns it on and still gets a refusal |
| 6 | Money received physically is recorded **and confirmed**, with auditable batch confirmation | `cash_receipt_confirmations`; `confirm_cash_receipts` performs every per-receipt check inside the batch and reports per receipt |
| 7 | Bank deposits awaiting clearance stay in transit and cannot support payouts | `1050`; `assert_spendable_account` refuses it; tested from the till, the bank and transit itself |
| 8 | A different authorized Manager or Owner verifies clearance; no self-verification | function raise **and** CHECK constraints, on verification, physical return and reversal |
| 9 | Separate booked, pending and available balances retained | `cash_account_availability`; the UI shows all three |
| 10 | Borrower repayment records preserved; only the company's use is restricted | one journal at receipt, unchanged; `loan_payments.status` untouched; every loan figure identical |
| 11 | No historical journal changed or reclassified | no backfill, no re-post. A journal dated before today carries no restriction at all — replaying history is not receiving cash |

### Where the design deliberately stops

The Owner's instruction was explicit: *"If the existing Decision A document
presents a genuinely unresolved situation … fail safely and document the
required decision rather than inventing an accounting treatment."*

So **deposit ageing, partial recovery, recovery receivables and loss
write-off (DD-2 to DD-5) are not implemented.** They rest on a qualified
accountant's determination of how `1190` and `2900` present at a reporting
date — blocker **B-1** of `POLYTOS-DECISION-A-D2-ACCOUNTING-REVIEW.md`, which
the Owner has not yet received. A deposit that never clears and never comes
back therefore stays `under_investigation`: honestly in `1050`, spendable by
nobody, with no automatic journal in either direction. That is the fail-safe
the instruction asks for, not an omission.

Also not implemented, and recorded as still open: the per-staff branch grants
of D-1/A-12, the refusal-attempt log of A-11, the booking-error correction of
C1–C7, and the three reconciliation paths of blocker B-2. Each is a separate
authorized change; none is a precondition of no-unfunded-payouts, and bundling
them would have made this unreviewable.

---

## 4. What this changes for the business

**A branch cannot lend money it does not have.** That is the whole of it, and
it is a real operational change:

- a disbursement from an unfunded till is refused, and the loan stays
  `approved` with no schedule and no journal;
- a repayment taken this morning cannot be lent out this afternoon until
  somebody has counted the drawer;
- cash taken to the bank is spendable by nobody until a second officer
  verifies the bank's own record of it.

**Before any live activation**, and independently of this code, the
implementation plan's §11.4 cutover still applies: signed per-account till
counts, bank confirmations for every bank account, and a documented initial
verified position approved by the Owner. "Absent means available" guarantees
that no historical figure moved; it does not establish that legacy till cash
is physically present. A migration cannot answer that and this one does not
pretend to.

---

## 5. What was measured

Every figure below was produced by running the gate named, locally, against a
real PostgreSQL 16 cluster, the real PostgREST 12.2.3 binary and the Next.js
production build. Nothing hosted was contacted.

| Gate | Result |
| --- | --- |
| `npm run typecheck` / `lint` / `format:check` | pass |
| `npm run audit:money` | pass — 277 financial files, no float hazard, five engines reaching only integer helpers |
| `npm run test:run` (unit + integration) | **90 files, 2,770 tests, 0 failed** |
| `npm run test:db` (17 projects) | **104 files, 2,571 tests, 0 failed** |
| `npm run check:security` | "No unreviewed privileged exposure" |
| `npm run certify:financial` | **41 identities: 39 pass, 2 explained, 0 vacuous, 0 fail**, with `--require-complete` |
| `node scripts/verify-membership-upgrade.mjs` | pass — **all 28 financial figures identical** across the upgrade |
| `node scripts/verify-policy-upgrade.mjs` | pass — 26 tables preserved |
| `npx playwright test --trace off` | **1,155 tests: 1,102 passed, 0 failed, 53 skipped**, against a stack rebuilt from zero |

### 5.1 The reproduction, before and after

The audit's finding was a branch till at **−345,000**: a 400,000 disbursement
out of a branch that had never been funded, which left the till at −400,000,
plus a 5,000 membership fee and a 50,000 savings deposit that brought it back
to −345,000. The disbursement is the act that created the negative position
and it is the act reproduced here, on the same migrated schema, with
`allow_negative_cash = false`:

| | Before Decision A | After |
| --- | --- | --- |
| A 400,000 payout from a till whose booked balance is 0 | **posted** | **refused** — `Cash at Hand — Head Office holds 0 shillings, which is less than the 400000 being taken out of it.` |
| `journal_entries` afterwards | 1 for that payout | **0 — none at all** |
| `journal_lines` afterwards | 2 | **0** |
| The till's booked and available balance | **−400,000** | **0 and 0** |

`tests/db/cash-sufficiency.test.ts` holds **30 tests**, one for each scenario
the ruling names and several for the ones its implementation implied. Its
first, *"refuses the −345,000 scenario the audit
found, and writes nothing"*, asserts the zeroes rather than only the refusal: a
guard that raised *after* posting would pass a test that checked the message
alone. The transaction is genuinely committed rather than rolled back, because
the second mechanism — the deferred constraint trigger — only fires at COMMIT
and a rolled-back attempt cannot see it.

A companion test takes the same refusal through the real loan path,
`disburse_loan`, and asserts that the loan is left **`approved`** with no
schedule: refused, not failed, so it can be disbursed once the till is funded.

### 5.2 The three new certification identities

Added to `scripts/certify-financial-reconciliation.mjs`, which the CI database
job runs with `--require-complete`:

| Identity | What it refuses to let pass |
| --- | --- |
| no cash account holds a negative available balance | the original defect, as a permanent gate rather than a one-off measurement. Splits a `historical` exception — an account whose last movement predates `finance_settings.cash_sufficiency_enforced_at` — from a `prohibited` one, so an upgraded book is not failed for its own past while a new overdraw is |
| every receipt restriction matches a real cash line | a restriction naming an entry, account or amount that does not exist, which would make availability a fiction |
| the availability view and the availability function agree | two derivations of one figure drifting apart, which is how a cached balance starts |

`agency_float` is excluded from the first, deliberately: a provider float
balance is governed by the provider's own electronic-float and payable rules,
which Owner instruction 2 says to preserve.

### 5.3 The historical-upgrade evidence

`scripts/verify-membership-upgrade.mjs` seeds a book on the schema as it stood
**before** these four migrations, applies them, and compares. It reports
**every one of 28 financial figures identical** — including
`journal_entries`, `journal_lines`, `journal_sums` and `journal_by_source`,
which is instruction 11 measured rather than asserted: no historical journal
was changed or reclassified. The 29 new ledger accounts it reports are the
per-branch transit accounts and are all at zero.

### 5.4 Where the test harness had to change, and why that is not a weakened test

Three existing assertions were **inverted**, and each inversion is the Owner's
decision taking effect rather than a test being made to pass:

| Test | Was | Is | Why |
| --- | --- | --- | --- |
| `money-movement.test.ts` | "permits an overdraft only when the business has said so" | "refuses an overdraft even when `allow_negative_cash` is on" | Instruction 5. The switch was withdrawn for controlled payouts |
| `ledger-posting.test.ts` | asserted at least one negative cash balance existed | asserts none does | The old premise *was* the defect: a fixture loan paid out of an account nobody had funded |
| `agency-foundation.test.ts` | funded an account by switching `allow_negative_cash` on | funds it with opening capital | Instruction 5 again. The test's own name always claimed it funded the account; now it does |

Everything else was a fixture putting money in before taking it out, which is
what a business does. No expected financial value was changed anywhere.

### 5.5 The approval-controlled paths, verified explicitly

The Owner asked for these four by name, and for no second definition of
available balance.

Transfers, expenses, Mobile Money and Agency transactions were never part of
the defect: all four already called `assert_cash_available`. What had to be
shown is that they now get the *new* rule rather than the old one, which they
do because `assert_cash_available` was **redefined to delegate** to
`assert_cash_funds_available` rather than left standing beside it. Nothing had
to be re-pointed, and nothing could be missed.

Two tests hold it:

- *"refuses an approved transfer whose funds have gone since it was raised"* —
  the threshold is lowered so the transfer is held for approval, the till is
  then drained by another route, and `approve_transfer` is refused. The check
  belongs where the journal is posted, not where the document was raised, and
  the transfer is left `pending_approval` rather than failed.
- *"asks one question, in one place, for every payout path"* — reads
  `pg_get_functiondef` for every function in `public` and asserts that each of
  the seven payout paths reaches the availability rule, that
  `assert_cash_available`'s whole body is a delegation to it, and that its text
  no longer mentions `allow_negative_cash`. A second implementation anywhere
  would be a second answer, and sooner or later a different one.

`post_reversal_journal` asks through one more step, deliberately:
`release_or_assert_receipt_reversal` decides whether reversing a receipt
*releases* its restriction — because nobody had counted the money — or is a
payout like any other, because somebody had. The test asserts that chain by
name rather than accepting its absence.

### 5.6 The fifteen scenarios the ruling lists, and where each is tested

Every one is in `tests/db/cash-sufficiency.test.ts` unless another file is
named. The last two races were added after the first pass of this note, so
that the list is covered literally rather than by analogy with a neighbouring
test.

| # | Scenario | Test |
| --- | --- | --- |
| 1 | Sufficient funds | *permits a payout the account can cover* |
| 2 | Insufficient funds | *refuses a payout one shilling beyond the balance* |
| 3 | Zero balance | *refuses a payout from an account holding nothing* |
| 4 | Booked but pending | *refuses a payout covered only by money nobody has confirmed*; *permits it once a different officer has confirmed the receipt* |
| 5 | Deposits awaiting clearance | *leaves the till, and is spendable from neither the till nor the bank* |
| 6 | Separate bank and cash accounts | *a funded bank account does not fund a payout from the till* |
| 7 | Concurrent disbursements | *two concurrent disbursements cannot both take the last of the till* — two real connections, the till funded for exactly one |
| 8 | Disbursement versus savings withdrawal | *a disbursement and another payout cannot both take the last of the till* |
| 9 | Benefit payment versus another payout | *a benefit payment and another payout cannot both take the last of the till* |
| 10 | Payout versus bank clearance | *a payout and a banking cannot both take the last of the till* |
| 11 | Unauthorised verification | *refuses the officer who recorded it as the one who verifies it* — two real named sessions, not two nulls |
| 12 | Reversal and duplicate posting | *releases the restriction when an unconfirmed receipt is reversed*; *treats the reversal of a confirmed receipt as a payout like any other*; *confirms a receipt once, however many times it is asked*; *records a deposit once, however many times the same key is used* |
| 13 | Branch isolation | *one branch cannot fund another branch, in either direction* |
| 14 | PostgREST and RLS access | *hides the confirmation register from a borrower, and shows it to a manager*; *grants the new capabilities to the roles the ruling names*; and `tests/db/postgrest-columns.test.ts`, which parses every `.select()` the application issues against the live schema |
| 15 | Full application and reporting accuracy | *keeps the six components of branch liquidity summing to the total*; *reports availability per account, with no aggregate column*; and the three new identities in §5.2, which the CI database job runs with `--require-complete` |

Plus the approval-controlled paths of §5.5, the inert switch, transit
unspendability from three directions, investigation posting nothing, and the
loan path end to end.

### 5.7 And through the buttons, since 2026-11-17

The fifteen scenarios above are proved in the database suite. They are now
also driven through the two screens, which is a different claim and was a
real gap: when this note was first written, the full browser suite passed
without ever touching either screen.

`tests/e2e/specs/cash-sufficiency.write.spec.ts` carries six journeys —
counting a drawer as a batch, a Secretary who may see it but not count it,
banking cash and clearing it as two different officers, a Manager refused the
clearance of their own deposit, an investigation that posts nothing, and an
Owner reversing a clearance by contra-entry. Each asserts the resulting
available balance against `cash_account_availability`, and asserts the
*change* against the receipt amounts the counter took in, so the screen and
the ledger have to agree and the identity has to hold.

Dropping `bank_deposits_verifier_not_recorder` from the schema fails all six;
rebuilding from the migrations passes all six. §H.8 of the certification
report records what they measured, and the one finding they produced: a
maker-checker refusal currently reads "Privilege denied on record." rather
than the sentence the database raised, which is the error boundary working as
designed and is ranked as L7.
