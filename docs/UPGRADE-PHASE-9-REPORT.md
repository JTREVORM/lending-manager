# Platform upgrade, Phase 9 — demo enrichment and certification

Phase 9 of the plan in `PLATFORM-UPGRADE-PLAN.md`: fill the gaps in the
demonstration dataset, then certify the whole platform.

The census that opened the phase is what shaped it. Four tables were empty:

| entity | rows before |
| --- | --- |
| `account_transfers` | 0 |
| `expenses` | 0 |
| `other_income` | 0 |
| `account_reconciliations` | 0 |

An entire module — the money movement of `20261011000200`–`0240` — had never been exercised
against live data. That is also why it still contained two defects: the only
thing that had ever run its code was a test suite, and both defects are about
how the functions behave *in sequence*, which a single-document test does not
see. Recording ten months of ordinary running costs found them in an hour.

So this phase is two fixes and an enrichment, in that order, because the
enrichment needed the first fix to be correct and found the second.

## 1. A count is compared against the day it was made

`submit_reconciliation` has always taken a business date, because counting a
till on Friday and entering it on Monday is ordinary bookkeeping. It then read
the balance with `ledger_account_balance`, which sums every line ever written
to the account with no date bound.

So the stored variance was the genuine difference on the day of the count
**plus every movement since** — and that whole figure is what
`approve_reconciliation` writes off to Cash Over and Short.

The demo's own numbers show the size of it. The till was counted at close on
Friday 9 October and entered on Monday the 12th:

| | |
| --- | --- |
| Books on 9 October | 2,748,418 |
| Counted | 2,744,918 |
| **True variance** | **−3,500** |
| Books on 12 October | 3,008,418 |
| Variance the old code would have stored | **−263,500** |

A 3,500 shortage would have been written off as a loss of 263,500 — because
2,500,000 was banked and 260,000 of collections arrived in the gap. On a count
that happened to be taken before a week of heavy collection, the sign flips
and a shortage is recorded as an overage.

The date was never the mistake; reading the balance without it was.
`ledger_account_balance_as_of` adds the cut-off, keyed on `entry_date` rather
than `posted_at` so that a backdated correction falls in the period it belongs
to. `assert_cash_available` deliberately keeps the uncapped reading: whether
money can leave an account is a question about now.

Every count the application itself submits is same-day, where as of today is
today, so nothing about present-day behaviour changed. Three of the nine new
tests in `tests/db/reconciliation-as-of.test.ts` fail against the old reading.

## 2. "Awaiting approval", said of things that were not

`record_transfer` and `record_expense` insert every document with status
`pending_approval` and let the posting function promote it. That is
deliberate, and the comment in `record_transfer` says why: exactly one place
sets `posted`, and it is the place that writes the journal.

The notification triggers in `20261015000200_notification_triggers.sql` were
then written as

```sql
after insert ... for each row when (new.status = 'pending_approval')
```

which reads like a gate and is in fact always true. Every transfer and every
expense announced to everyone holding the approving capability that it needed
a decision — including the ones that posted on the way in and needed nobody's.

Recording the ten months of running costs below produced **69**
`approval_pending` notifications, of which **62 were false**: 55 expenses and
7 transfers that had never waited for anything. In production that is one
notification per petty cash slip, which is how a notification system stops
being read.

`notify_reconciliation_variance` has the same shape. It is inert while
`reconciliation_requires_review` is true, because the row then keeps the
status it was inserted with — but with review switched off,
`submit_reconciliation` writes the difference off in the same transaction and
the count would still have been announced as awaiting a review that had
already happened.

All three now **defer to commit** and read the row as it finally stands. A row
trigger cannot be deferred, so they become constraint triggers, which can.
They stay triggers rather than moving into the recording functions, so that a
notification still cannot be forgotten by a caller. Four of the ten new tests
in `tests/db/notify-pending-only.test.ts` fail against the old triggers.

## 3. What was enriched, and what was not

Written through the real functions as real signed-in users, so every actor and
label is derived rather than supplied. The Secretary/Treasurer records; the
Manager and the Owner decide. Winnie was refused when she tried to approve her
own transfer, which is the separation of duties working rather than a test of
it.

### Money movement — 11 transfers

Nine posted, one rejected, one still waiting. The business had been taking
collections on mobile money and almost never moving them: 15.2m had come in
across MTN and Airtel and 130,000 had ever left, while the till was drained to
109,050 by the end of September. The missing withdrawals are what made the
existing cash history implausible, so adding them is restoring the dataset
rather than decorating it.

| | date | from → to | amount | outcome |
| --- | --- | --- | --- | --- |
| TF2600001 | 6 Feb | MTN → till | 1,200,000 | posted |
| TF2600002 | 5 Mar | MTN → till | 800,000 | posted |
| TF2600003 | 4 May | Airtel → till | 700,000 | posted |
| TF2600004 | 3 Jul | MTN → till | 200,000 | posted |
| TF2600005 | 5 Aug | MTN → till | 1,000,000 | posted |
| TF2600006 | 8 Sep | Airtel → till | 1,200,000 | posted |
| TF2600008 | 16 Sep | MTN → till | 2,500,000 | **approved** by the Manager |
| TF2600009 | 17 Sep | MTN → till | 2,500,000 | **rejected** — duplicate of TF2600008, same MTN reference on both |
| TF2600007 | 7 Oct | MTN → bank | 2,000,000 | posted |
| TF2600010 | 9 Oct | till → bank | 2,500,000 | **approved** by the Manager |
| TF2600011 | 12 Oct | MTN → bank | 2,500,000 | **waiting** |

TF2600007 at exactly 2,000,000 posted without a decision, which is the
threshold being compared with `>` and is worth knowing.

### Running costs — 58 expenses, 5,888,000 posted

Ten months of premises, operations and transaction costs. One above the
1,000,000 threshold was approved by the Owner, one was rejected, one is
waiting.

| account | n | total |
| --- | --- | --- |
| Rent | 10 | 2,500,000 |
| Other Expenses (licence) | 1 | 1,250,000 |
| Internet and Airtime | 10 | 500,000 |
| Utilities | 9 | 458,000 |
| Transport | 10 | 420,000 |
| Stationery | 4 | 370,000 |
| Fuel | 2 | 145,000 |
| Mobile Money Charges | 8 | 125,000 |
| Repairs and Maintenance | 1 | 95,000 |
| Bank Charges | 1 | 25,000 |

The mobile money charges are tied to the withdrawals that incurred them and
carry the same operator reference, so the register reads as one story rather
than two.

**EX2600057**, the UMRA money lender's licence renewal at 1,250,000, waited
and was approved by the Owner. **EX2600056**, 1,100,000 of branding, was
rejected by the Manager — "no quotation attached and nothing was agreed
beforehand" — and wrote no journal. **EX2600058**, 1,400,000 of rewiring, is
waiting.

### Counts — 5 reconciliations

Three balanced and posted nothing. One carried a 3,500 shortage, was approved
by the Manager and wrote 3,500 to Cash Over and Short **dated 9 October**, the
day of the count, not the day of the signature. One — the bank, 12,000 against
the Centenary statement — is still waiting, because the difference is being
queried with the bank before anything is written off.

### Salaries and Wages: deliberately zero

Four people and ten months of trading, and the payroll account is empty. That
is not an oversight.

The seeded book has 21,449,163 of owner capital, 26,500,000 disbursed and
4,525,560 of income earned. A four-person payroll at any believable Kampala
rate is 16m–24m over the period. The money is not there, and it never was. The
options were to post a payroll the cash cannot support, to invent an equity
injection to fund one, or to leave it out and say so. Inventing the capital
would rewrite the funding history every earlier phase was certified against.

So the expense history covers premises, operations and transaction costs, and
the owner-operated reality — staff paid out of pocket and never put through
the books — is left as what it is. The result is a first-year lender running
at a loss of **1,362,440** before any payroll, which is both honest about this
dataset and a more instructive thing to demonstrate than a fabricated profit.

### Other income: deliberately zero

`loan_products` has no fee column of any kind, so the four fee accounts in the
chart cannot be charged by any configured product. Posting application or
processing fees across the existing 35 loans would assert a fee policy that
nothing in the loan agreements supports — the snapshots are the contractual
record and they mention none.

The one candidate for genuine other income turned out not to be income at all.
The sewing machine realised against LN260014 sold for 300,000, and Phase 5 had
already recorded it correctly as **PAY260470**, a payment reducing the
borrower's debt from 414,006 to 114,006. Principal recovered is not revenue,
and booking those proceeds as other income would have broken that rule while
looking like diligence.

`other_income` therefore stays empty, and the gap it points at is recorded in
section 6.

### No second branch

One branch, as the business has one office. The branch-sliced views work and
have nothing to slice, which is the honest state of a single-office lender
rather than something to pad.

## 4. Live verification

Every figure below was read back off the live project after the enrichment.

**The trial balance holds.** 88,487,530 on each side, variance 0, across 564
entries and 1,601 lines. No individual entry is unbalanced.

**Cash reconciles to the plan exactly.** The movements were simulated against
ten months of existing daily balances before any of them were applied, because
`assert_cash_available` guards the present and not the past — a backdated
withdrawal can pass it and still leave a day in March overdrawn. The
simulation predicted a closing liquidity of 11,344,530 and the live book
reports 11,344,530.

| account | before | after |
| --- | --- | --- |
| Cash at Hand | 2,146,418 | 3,004,918 |
| MTN Mobile Money | 10,974,067 | 3,178,067 |
| Airtel Money | 4,115,545 | 1,936,545 |
| Cash at Bank | 0 | 3,225,000 |
| **Total liquidity** | **17,236,030** | **11,344,530** |

**No day in the history is overdrawn.** The minimum balance of every cash
account across all 316 days is 0, and 0 only on the days before that account
was first used.

**Every accounting rule in the brief holds**, checked as queries against the
live ledger rather than by review — 0 violations on each:

- no disbursement entry touches an expense account
- no payment entry credits a fee or other-income account
- no transfer entry touches anything but a cash account
- every expense entry debits an expense account
- no journal is claimed by two documents, and no document has two journals
- every transfer, expense and reconciliation entry carries its `source_id`

**No orphans.** Every posted document has a journal; no pending or rejected
document has one. The rejected transfer and the rejected expense moved no
money, and the three documents still waiting have written nothing.

**Schema parity.** All five categories the repository controls hash
identically on the live project and on a database built from the migrations
alone: 145 functions, 140 triggers, 88 policies, 579 constraints, 33 views.
The only live-only object is `public.__gate_probe`, a view defined as
`SELECT 1 AS one` left by an external tool, documented in the Phase 4 and
Phase 5 reports and accounting for the one extra view and its one column.

## 5. Verification

| | |
| --- | --- |
| Test files | 113 passed |
| Tests | 3,384 passed |
| New tests this phase | 19 (9 as-of, 10 notification gating) |
| `npm run lint` | clean |
| `tsc --noEmit` | clean |
| `npm run build` | succeeds |
| `audit-financial-arithmetic` | 58 files, no hazard |
| Migrations | apply in order to an empty database |

## 6. Recorded for whoever comes next

Three things this phase found and did not change, because each is a decision
rather than a defect.

**Loan products cannot charge a fee.** The chart of accounts provides for
application, processing, registration and documentation fees. `loan_products`
has no column for any of them, so the only way to charge one is by hand
through `record_other_income`. Either the accounts are aspirational or the
product model is incomplete; the business should say which. Adding fee terms
to a product is a schema and workflow change, which is new feature work rather
than certification.

**The opening capital was seeded into the till.** 21,449,163 was posted to
Cash at Hand on 12 December 2025 and drawn down from there, so the till reads
above 6m for 268 of the 304 days it has been open and peaks at 20,287,160. Twenty million
shillings in an office safe in Kyebando is not a thing that happens. Correcting
it means restructuring posted history, which the append-only ledger rightly
forbids, so it stands. The enrichment improves the same problem where it
could: MTN's peak falls from 10,974,067 to 4,953,543, and the bank account is
in use from October. A future seed should put the capital in the bank and draw
it to the till as disbursements require.

**62 false notifications are still live.** They were raised by the defect in
section 2 before it was fixed, they name documents that posted instantly and
needed no decision, and `notifications` is append-only by design. Removing
them is a deletion against live data, which is not something a phase does on
its own initiative. They are listed by `category = 'approval_pending'` where
the document they name is `posted` with no `approved_by`.
