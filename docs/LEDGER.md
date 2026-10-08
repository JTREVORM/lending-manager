# The financial ledger

Up to Phase 10 the system knew, to the shilling, what every borrower owed. It
knew nothing at all about where the company's own money was. `loan_payments`
recorded that 150,000 arrived by MTN; nothing recorded that MTN therefore held
150,000 more than it did. Cash at Hand, the two wallets and the bank were not
objects in the schema — they were adjectives on a payment row.

This is the module that closes that gap, and the foundation that transfers,
expenses, other income, daily reconciliation, the liquidity cards and the whole
Financial report family stand on.

---

## The accounting model

Double entry, **cash basis**. Income is recognised when it is collected, not
when it is charged:

```
Dr Cash / MTN / Airtel / Bank
  Cr Loans Receivable        the principal component
  Cr Interest Income         the interest component
  Cr Penalty Income          the penalty component
```

Two consequences follow, and both are deliberate.

**`Loans Receivable` carries principal only.** It is the money paid out less
the principal component of what has come back — which is exactly the figure
`dashboard_portfolio_summary.principal_outstanding` already reports, and a
reconciliation test asserts the two are equal. Interest that has been charged
but not received is not an asset here; it is simply not yet income.

**Charging a penalty posts nothing.** No money moves, and under cash-basis
recognition no income arises until the borrower pays. The penalty reaches the
books through the `allocated_penalty` component of the repayment that settles
it. `ensure_penalty_applied` therefore needs no ledger wiring, and has none.

## The four tables

| Table | Purpose |
| --- | --- |
| `branches` | A place the business operates from. Cash accounts belong to one. |
| `ledger_accounts` | The whole chart of accounts in one table. |
| `journal_entries` | The header of a balanced posting. Append-only. |
| `journal_lines` | One side of one posting. Debit and credit are separate columns. |

### Why one chart rather than a cash-accounts table

Double entry needs more than the four places money sits. A disbursement
credits Cash and debits Loans Receivable; a repayment splits across Loans
Receivable, Interest Income and Penalty Income. If the four cash accounts
lived in their own table, every journal line would point at one of two tables
and every balance query would be a union.

So there is one `ledger_accounts` table, and the four cash kinds are the rows
that additionally carry a `branch_id` — because cash is the only thing that is
physically *somewhere*. Income and expense are company-wide and sliced by
branch through the entry, which carries one. Cloning them per branch would
make a trial balance list "Interest Income — Nansana" as a separate account
from "Interest Income", which is a reporting dimension pretending to be an
account.

### Account codes

```
1010-<branch>   Cash at Hand
1020-<branch>   MTN Mobile Money
1030-<branch>   Airtel Money
1040-<branch>   Cash at Bank
1200            Loans Receivable
3000            Owner Capital
4100            Interest Income
4200            Penalty Income
```

A unique partial index allows one Cash at Hand, one MTN float and one Airtel
float per branch; `bank` is excluded from that rule, because a branch may hold
several bank accounts.

## What the schema guarantees

**Every journal balances.** A deferred constraint trigger
(`DEFERRABLE INITIALLY DEFERRED`), not an application check: lines are
inserted one at a time, so the rule cannot be evaluated per row. It is
evaluated at commit, against the whole entry, so an unbalanced journal cannot
be committed by the application, by `service_role`, or by a hand-typed
INSERT — which is the only version of this rule worth having. The same trigger
refuses an entry with fewer than two lines.

**A line has exactly one side.** `(debit = 0) <> (credit = 0)`, with both
columns non-negative. A line that moves nothing is noise in a ledger people
read.

**The ledger is append-only.** `journal_lines` cannot be updated or deleted.
`journal_entries` cannot be deleted and permits exactly one update: stamping
the contra entry that reverses it. A correction is a contra entry, which is
both the accounting convention and the only form that leaves the original
visible.

**An event posts once.** A unique index on `(source_type, source_id)` makes a
second journal for the same disbursement, payment or reversal impossible at
the storage level rather than something detected afterwards. This is also what
makes the historical backfill idempotent.

**Cash accounts are assets, and only cash is branch-held.**
`(cash_kind is null) = (branch_id is null)`, and a row with a `cash_kind` must
be an `asset`. Without the second constraint a typo could make Cash at Hand an
income account and every balance wrong.

## Posting

`post_journal` is the only way a journal is written. It takes the whole
entry — header and every line — so a half-posted journal is not a state it can
leave behind, and the deferred balance check sees a complete entry. Components
that are zero are dropped rather than posted as empty legs.

Three functions sit on top of it, one per event:

| Function | Posting |
| --- | --- |
| `post_disbursement_journal(loan)` | Dr Loans Receivable, Cr the branch's Cash at Hand |
| `post_repayment_journal(payment)` | Dr the receiving account, Cr Receivable / Interest / Penalty by the payment's own allocation components |
| `post_reversal_journal(payment)` | The exact contra of the repayment journal, dated the day of the reversal |

Each reads the records rather than taking figures as arguments, so it cannot
be handed a number that disagrees with the ledger it is posting for, and each
returns NULL when the event is already posted. `post_repayment_journal`
refuses outright if the three allocation components do not sum to the payment:
the journal would balance only by inventing a figure.

### Atomicity

`disburse_loan`, `post_payment` and `reverse_payment` each call their posting
function before returning. A raise inside a PL/pgSQL function with no handler
aborts the whole transaction, so there is no ordering of events in which the
loan or payment mutation commits and the journal does not. The money record
and its two ledger sides are one transaction or they are nothing.

`post_repayment_journal` is called **last** in `post_payment`, after the
allocations exist and after the existing reconciliation has proved them,
because the journal is posted *from* those allocations.
`post_reversal_journal` is called after `ensure_penalty_applied`, so that a
penalty the reversal re-exposes is already materialised and the transaction
records both or neither.

## Reading balances

| View | Answers |
| --- | --- |
| `ledger_account_balances` | Every account's debit total, credit total and balance, signed the way the account is read |
| `branch_cash_position` | Cash at Hand, the two wallets and the bank per branch, with their total |
| `trial_balance` | Debit and credit totals per account; the two columns foot to the same figure |

All three are `security_invoker = true`, so RLS decides who sees what. Note
that a view created in `public` inherits this deployment's
`ALTER DEFAULT PRIVILEGES`, which hands `anon` every privilege including
DELETE — so each one is explicitly revoked before `select` is granted. That is
not tidying: without it the balance views would be world-readable before a
single policy was consulted.

## Who may see and do what

| Capability | Owner | Manager | Secretary / Treasurer |
| --- | --- | --- | --- |
| `branches:view` | ✓ | ✓ | ✓ |
| `branches:create` | ✓ | | |
| `branches:update` | ✓ | ✓ | |
| `ledger:view` | ✓ | ✓ | ✓ |
| `ledger:post` | ✓ | | |

Reads go through a capability. Writes do not go through RLS at all: every
posting is made by a `SECURITY DEFINER` function, because a ledger anybody can
INSERT into directly is a ledger with no guarantee that the two sides of an
event were written by the same hand.

## Branch assignment

`clients.branch_id` and `loans.branch_id` are both NOT NULL, and both are
supplied by a trigger when the caller does not name one. A loan takes its
borrower's branch, because a loan is issued where the relationship is held; a
client with no branch named takes the primary one.

The triggers exist because nothing that creates a client or a loan today knows
branches exist — not the server actions, not the test harness, not a
hand-written INSERT. Making the columns mandatory without them would have
broken client registration and loan creation outright. When a later phase gives
the UI a branch picker it will pass a value and the triggers will stop firing,
without anything here changing.

## Migrations

```
20261010000100_branches_and_ledger.sql   the four tables, the balance rule, the three views, the capabilities
20261010000200_ledger_backfill.sql       Head Office, the chart, Bank as a payment method, the historical backfill
20261010000300_ledger_posting.sql        disburse_loan, post_payment and reverse_payment post their own journals
```

Split three ways deliberately: the structure can be reviewed, and reverted,
without touching a function that handles real money.

## The opening capital

The demo had paid out 26,500,000 and taken back 22,000,000 with no cash
accounts behind it, so a backfill with no opening entry sends Cash at Hand
negative on day one. The entry that fixes it was **derived, not chosen**.

Replaying every disbursement and every cash movement in timestamp order, the
running Cash at Hand balance reaches its lowest point at **−21,449,163**. So
the opening entry is 21,449,163 into Cash at Hand, credited to Owner Capital,
dated the day before the first disbursement — the smallest figure that keeps
the cash position non-negative throughout its whole history, and not one
shilling more. Cash at Hand touches exactly zero at its lowest point, which a
test asserts. A rounder, larger number would have made the dashboard look
better and the figure arbitrary.

MTN and Airtel never go negative at any point in the history, and the bank
account has no historical movement, so none of the three carries an opening
entry.
