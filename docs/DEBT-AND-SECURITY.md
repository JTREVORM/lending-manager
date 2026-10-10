# Debt & Security

What the business holds against a loan, what it does when a loan goes bad, and
how both are measured. Phase 14 of the platform upgrade; the evidence that it
was applied is in `UPGRADE-PHASE-5-REPORT.md`.

This document is about the three things that are new — security, recovery, and
the two aggregates above them. Arrears, grace periods and penalties were built
in Phase 7 and are unchanged; see `LOANS.md`.

---

## 1. Security: what a loan is written against

`public.loan_collateral` holds one row per pledged item: what it is, what
somebody judged it to be worth and on what date, a serial or registration
number where the item has one, where it is kept, and whether it is still held.

### An item has two lives

Before the money moves it is part of the application — a description a loan
officer types, corrects and re-values while the file is being assembled. From
the moment the loan is active it is **evidence**: the thing the business agreed
to lend against, and the thing it will point at if the borrower does not pay.
So `loan_collateral_guard` freezes the item's *identity* at disbursement —
type, description, valuation, valuation date, serial number, ownership
document — and refuses a DELETE outright.

What never freezes is the *status*. An item is `held`, then `released` when it
goes back to the borrower, or `realised` when it is sold to recover the debt.
Those are events that happen to a live loan by definition, and a guard that
froze them would freeze the only thing security is for. The status moves
forward only: an item handed over or sold cannot be un-handed, and the guard
says so rather than silently allowing it.

`released_at`, `released_by`, `realised_at` and `realised_by` are stamped by
the guard from the session. A payload that supplies one is refused — a release
dated to a day it did not happen is worse than no record.

### A valuation is not an obligation

`estimated_value` is what somebody thought the item was worth on
`valued_on`. It is **not** a figure any balance is computed from, it posts
nothing to the ledger, and realising an item does not reduce a loan by its
valuation.

A realisation is money, and money reaches the books as a payment through
`post_payment` like every other shilling. `realised_amount` records what the
sale fetched, as a fact about the item; the loan moves when the receipt is
posted. The screen says this above the button, because a staff member who
believes the balance has already moved will not post the receipt.

Zero is a legitimate `realised_amount`. An item that fetched nothing at auction
is a real and painful outcome, and refusing to record it would leave the
register saying the item is still held.

### Capabilities

| Capability | Who holds it | What it opens |
| --- | --- | --- |
| `collateral:view` | Secretary/Treasurer, Manager, Owner | The security on a loan, and the register across the book. |
| `collateral:manage` | Secretary/Treasurer, Manager, Owner | Recording an item, releasing it, realising it. |

There is deliberately no `collateral:delete`. An item taken in and no longer
wanted is *released*, which is a status with a date and an actor.

---

## 2. Releasing a guarantor

Most guarantees end by themselves. The loan clears and the undertaking is
`discharged`; the loan is cancelled and it is `void`. Neither needs a column,
because the loan already records it and a derived status is always right.

What needs recording is the **discretionary** release — a Manager letting a
guarantor out while the loan is still live, usually because security was
substituted or another guarantor took their place. `loan_guarantors` gained
`released_at`, `released_by` and `release_reason` for exactly that, and the
reason is required: the guarantor is the person who will come back and ask.

### It goes through a function, not a column write

`public.release_loan_guarantor(p_loan_guarantor_id, p_reason)` holds four
rules:

1. the caller holds `guarantors:release`;
2. a reason was given;
3. the loan has been disbursed and is not finished — a draft's guarantors are
   *removed* from the application, and a finished loan's guarantee ended with
   it;
4. the loan keeps the number of guarantors its product requires. Releasing the
   last guarantor of a loan that needs one is refused rather than warned
   about, because the alternative is a live loan the business thinks is
   secured.

The RLS on `loan_guarantors` was written for application assembly
(`loans:update_draft` plus `guarantors:link`). Releasing a guarantee from a
live loan is senior work, and it is nobody's business to be editing draft
applications in order to do it — so the release is a definer function with its
own capability and the table's policies are unchanged.

A release written straight to the column is refused by
`loan_guarantors_guard_snapshot`, which also refuses to let a release be
undone or reworded. A guarantor who has been told they are out stops worrying
about the loan; taking that back silently would make the register a liar about
the thing it exists to state.

### Guarantee status

Derived, in `public.guarantor_exposure`:

| Status | Meaning |
| --- | --- |
| `proposed` | Named on an application that has not been disbursed. |
| `unsigned` | Attached to the loan, but the undertaking is not signed. |
| `binding` | Signed, and the loan is still owed. |
| `released` | Let out by the business, with a recorded reason. |
| `discharged` | Ended when the borrower cleared the loan. |
| `void` | Ended when the loan was cancelled. Nothing was ever lent. |

"Discharged" and "released" are deliberately different words. A guarantor
asking "am I still liable?" is owed the reason as well as the answer.

### Exposure is the loan's, undivided

A guarantee in this business is joint over the whole loan — nobody signs for a
slice of it. So two guarantors on one loan each show the full outstanding
balance, and the register says so under the table: the column is not a
division of the debt and does not sum to the loan book. Halving it would be
inventing a term nobody agreed to.

---

## 3. Recovery: the chasing, written down

`public.loan_recovery_actions` records the work done against a loan: calls,
visits, messages, written notices, internal notes and promises to pay.

Before this existed, the arrears figure was visible and the effort against it
was invisible — which makes the one number the business can see, "fourteen
loans overdue", impossible to act on, because nobody can tell which of the
fourteen were called yesterday and which have been untouched for a month.

### Append-only, enforced

A recovery note is evidence of what was known and said at the counter. Its
whole value is that it cannot be quietly reworded once the loan goes bad, so
the table is append-only the same way `audit_log` and `client_remarks` are:
statement-level BEFORE triggers that refuse UPDATE and DELETE outright, rather
than merely withholding the grants. Statement-level matters — the refusal does
not depend on an attacker's WHERE clause matching anything, and withholding a
grant stops a session while a leaked service key is not a session.

A mistake is corrected by appending an action of kind `correction` that points
at the entry it supersedes. The register shows the original struck through with
the correction beneath it. Both stay readable, which is the whole point of a
file somebody will later be asked to justify.

`created_by` and `created_by_label` are derived from the session by trigger. A
supplied label is discarded: an action attributed to somebody who did not make
the call is the one thing a recovery file must never contain.
`created_by_label` keeps the author's name readable after the account is
archived.

Recovery activity is refused on a loan that was never disbursed. A draft has
nothing to recover, and a collection call recorded against an application would
be a fiction.

### A promise to pay is not a rescheduling

"He will pay 200,000 on Friday" changes nothing contractual. The installment is
still due when it was due, the arrears figure is still what it is, and the
penalty clock keeps its own time. A promise is a staff member's record of what
a borrower said, so it lives beside the call that produced it and never goes
near the repayment schedule.

Whether a promise was kept is therefore **derived**, never stored: posted
payments on that loan from the day the promise was given through the day it was
for, measured against the amount promised.

| Verdict | When |
| --- | --- |
| `kept` | Posted payments in the window reach the promised amount. |
| `pending` | The date has not passed and the amount is not yet met. |
| `broken` | The date passed without the promised amount being paid. |

Nothing has to remember to mark a promise broken, and a reversal that undoes
the payment which kept one **un-keeps it automatically** — because the promise
was only ever a question asked of the payments table. The register shows what
was paid in the window beside the verdict, so nobody has to take it on trust.

The label is "Not kept", not "broken". The register is read aloud to borrowers,
and the system's job is to record whether the money arrived, not to
characterise the person.

### Follow-ups

Any action may carry a `follow_up_on` date. It is independent of a promise — a
call that reached nobody still earns a follow-up — and it is not derived from
arrears. A loan appears on the follow-up worklist because somebody said they
would come back to it and has not.

`public.loan_recovery_status` is one row per disbursed loan: its arrears
position, when it was last worked and by whom, the next follow-up, the missed
follow-up, and the live promise if there is one. "Live promise" means the most
recent one — a borrower who promises Friday and then re-promises Monday has one
promise, the later one.

### Capabilities

| Capability | Who holds it | What it opens |
| --- | --- | --- |
| `recovery:view` | Secretary/Treasurer, Manager, Owner | A loan's recovery history, the follow-up worklist, the promise register. |
| `recovery:record` | Secretary/Treasurer, Manager, Owner | Recording an action, a follow-up or a promise. |

Reading and recording are split; there is no edit or delete capability,
because the table offers neither. A `recovery:edit` capability would be a
promise the schema cannot keep.

---

## 4. Aging

`public.loan_aging` is the active book — `active`, `grace_period`, `arrears` —
one row per loan, bucketed by how late it is. A cleared loan is not at risk and
is not in the portfolio either; including it would flatter every ratio.

| Bucket | Days past due |
| --- | --- |
| `current` | 0 or fewer |
| `1_7` | 1 to 7 |
| `8_30` | 8 to 30 |
| `31_60` | 31 to 60 |
| `61_90` | 61 to 90 |
| `90_plus` | 91 or more |

The view adds no arithmetic of its own. `days_past_due` already exists and is
already the agreed figure — net of the grace period, measured from the oldest
unpaid installment — and the bucket is one `case` over that one column, so a
screen and a report can never disagree about whether a loan is 30 days late or
31. `lib/domain/risk.ts` mirrors the same `case` for previews, and a test in
each suite drives the same boundaries so the two definitions stay in step.

`aging_rank` exists because the labels do not sort: `'1_7'` sorts after
`'31_60'`, and a register ordered by the label reads as nonsense. The worklist
orders worst first — a list that opened on the loans one day late would bury
the ones three months late beneath them.

---

## 5. Portfolio at Risk

`public.portfolio_at_risk` quotes PAR at five thresholds, for the whole active
portfolio and sliced by branch, by product, and by both. `scope` names which
row is which, and the grouping sets come back in one read, so a caller takes
any slice without a second query.

> **PAR _n_ = outstanding principal on loans at least _n_ days past due ÷
> total outstanding principal.**

Principal, not total outstanding, and not the arrears figure. Those are the two
substitutions that quietly turn PAR into a different ratio that happens to
share its name: interest not yet earned is not portfolio, and a penalty is not
principal lent.

The ratios are stored as integer basis points, computed once in the view rather
than in four callers. They are **null, not zero**, where there is no principal
to divide by — a branch with no active loans has no PAR, and 0.0% would read as
perfect health. `formatRatioBps` renders null as a dash.

`ratioSeverity` in `lib/domain/risk.ts` tints a tile at 5% and 15%. It is a
presentation hint and deliberately not configurable: nothing is decided by it,
no figure changes, and a business setting for "what counts as bad" would be a
number somebody tunes until the dashboard looks calm.

---

## 6. Collections, sliceable

`payment_register` has carried the method and the recording staff member since
Phase 8, which covers Collections by Method and by Staff. Collections by Branch
and by Product were impossible, because the view never joined either. Phase 14
adds `branch_id`, `branch_name`, `loan_product_id`, `product_code` and
`product_name`.

All four come from the **loan**, not from the receipt. A payment has no branch
of its own: it is a receipt against a loan, and the loan is what belongs to a
branch. So these read as "the branch that owns this lending", not "the counter
the cash was handed over at" — a distinction that matters the day the business
opens a second branch and a borrower pays at the wrong one.

### One query, five slices

`getCollectionSummary` in `lib/data/collections.ts` reads the register once for
the period and sums it five ways: by method, by staff member, by branch, by
product and by day. This is ADR-042's doctrine, and the reason for it is more
visible here than anywhere: five `group by` queries would be five chances for
the figures to disagree — a reversal posted between the second and the fourth,
and the method totals no longer add up to the staff totals, with nothing on the
screen to say why. One read, summed five ways, cannot do that, because every
slice is a partition of the same list.

A reversal contributes nothing to any amount — `payment_register` already
zeroes `effective_amount` and the three `*_collected` columns for a reversed
payment — but its **count** is reported beside the receipts. A day with eight
receipts and one reversal is a different day from one with seven receipts, and
a summary showing only the net would hide the correction that was made.

The summary reads at most 5,000 rows and says whether it saw the whole period.
A summary built from a truncated read is a wrong summary, not a partial one, so
the screen refuses to be trusted rather than rendering a figure somebody banks
on.

---

## 7. The screens

| Route | Capability | What it is |
| --- | --- | --- |
| `/overdue` | `delinquency:view` | Unchanged. The morning worklist: who is behind, what to ask for, which number to call. |
| `/recovery` | `recovery:view` | The hub, in five views: aging, risk monitoring, follow-ups, promises to pay, security held. |
| `/guarantors/register` | `guarantors:view` + `loans:view` | The guarantor register with exposure. |
| `/payments/summary` | `payments:view` | The Collection Summary, cut five ways. |
| `/loans/[loanId]` | `collateral:view`, `recovery:view` | Two new sections: Security (items plus the guarantees and their exposure) and Recovery (the chase, the promises, the form). |

`/overdue` and `/recovery` are two routes rather than one because they answer
different questions and are opened by different people. The morning list is
read standing up, often outdoors, and should not have to load a portfolio
aggregate to show itself; the hub reads one by design. Two capabilities, so a
business can open the first to the counter while the second stays with the
people who work it.

The hub queries **one view at a time**, from the URL. Five registers fetched
for a screen showing one of them would be four wasted round trips on every
visit. The exception is the aging view, which also reads the risk aggregate:
the bucket chips carry counts, and those counts come from the same aggregate
the risk view shows — one read serving both, which is why the chips can afford
to say "9" where the loan register's stage tabs deliberately do not.

---

## 8. What Phase 14 does not touch

- **Allocation.** Penalty, then interest, then principal, decided by
  `post_payment`. Nothing here re-decides it, and the Collection Summary
  reports the split rather than computing one.
- **The ledger.** No table, trigger or function added in this phase writes a
  journal line. A realisation is recorded as a sale; the money reaches the
  books through `post_payment`.
- **Arrears, grace and penalties.** Phase 7's, unchanged. Aging is a
  presentation of `days_past_due`, not a second opinion about it.
- **The repayment schedule.** A promise to pay comes nowhere near it.
