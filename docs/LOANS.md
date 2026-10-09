# The loan engine

Phase 4. Everything here is implemented and tested; nothing below describes a
later phase as done.

> **Treat every figure on this page as a contractual record.** A wrong balance
> is not a cosmetic bug — it is a false claim about what a borrower owes.

## The interest model

Reducing balance on the **opening principal of each period**, which is the
business's confirmed rule:

```
interest(n) = round_half_up( openingPrincipal(n) × rateBps / 10 000 )
```

Note what this is *not*. It is not a flat rate on the original principal, which
would charge the same interest every month. It is not an amortising annuity,
which would hold the monthly payment constant and solve for the principal
split. Here the principal portion is level and the interest shrinks with the
balance, so the monthly obligation **declines**.

### The three confirmed examples

**UGX 100,000 over 1 month at 15%**

| Month | Opening | Principal | Interest | Due | Closing |
| --- | --- | --- | --- | --- | --- |
| 1 | 100,000 | 100,000 | 15,000 | **115,000** | 0 |

Total interest 15,000 · **total repayable 115,000**

**UGX 200,000 over 2 months at 15%**

| Month | Opening | Principal | Interest | Due | Closing |
| --- | --- | --- | --- | --- | --- |
| 1 | 200,000 | 100,000 | 30,000 | **130,000** | 100,000 |
| 2 | 100,000 | 100,000 | 15,000 | **115,000** | 0 |

Total interest 45,000 · **total repayable 245,000**

**UGX 600,000 over 3 months at 15%**

| Month | Opening | Principal | Interest | Due | Closing |
| --- | --- | --- | --- | --- | --- |
| 1 | 600,000 | 200,000 | 90,000 | **290,000** | 400,000 |
| 2 | 400,000 | 200,000 | 60,000 | **260,000** | 200,000 |
| 3 | 200,000 | 200,000 | 30,000 | **230,000** | 0 |

Total interest 180,000 · **total repayable 780,000**

All three are asserted against hand-written literals in
`tests/unit/loan-engine.test.ts` and independently reproduced in SQL by
`tests/db/loan-engine-parity.test.ts`. Neither derives its expectation from the
code under test.

## Rounding and representation

| Rule | How |
| --- | --- |
| Currency | UGX, whole shillings. There is no smaller unit. |
| Rates | Integer basis points. 15% is `1500`. |
| Intermediate arithmetic | Exact: `BigInt` in TypeScript, `bigint` in SQL. |
| Final rounding | Half-up, to the nearest shilling. |
| Principal remainder | Placed in the **final** period(s). |
| Floating point | None, anywhere on the loan path. |

**Half-up, demonstrated.** `445` at 50% is exactly `222.5`. Half-up gives
**223**; banker's rounding would give 222, because 222 is even. Both engines
return 223, and that case is in both test suites precisely because it is the
one that distinguishes the modes.

In TypeScript, `applyRateBps` multiplies in `BigInt` and divides once:

```ts
remainder * 2n >= absDenominator ? quotient + 1n : quotient
```

In SQL, the same result from integer arithmetic by adding half the divisor
before an integer division:

```sql
(opening * rate_bps + 5000) / 10000
```

**The remainder is never lost.** `divideEvenly` splits in `BigInt` and gives
the last periods the extra shillings, so UGX 200,001 over two months is
100,000 then **100,001** — not two portions of 100,000 with a shilling
vanishing. `scripts/audit-financial-arithmetic.mjs` checks the loan path
mechanically for float literals, `parseFloat`, `Math.round`, `toFixed` and
float casts, and verifies that the engine reaches only integer money helpers.
Run it with `npm run audit:money`.

## Which engine is authoritative

There are two implementations, deliberately:

| | Implementation | Role |
| --- | --- | --- |
| **Authoritative** | `public.calculate_loan_breakdown` | Computes what is **stored** at approval |
| Preview | `lib/domain/loan.ts` | Computes what staff **see** while entering a loan |

The split exists because `approve_loan` must not accept figures from its
caller. An approver who could supply the breakdown could approve a loan at zero
interest, and `loans:approve` is held by the Manager — so the figures are not
the caller's to supply.

Two implementations that must agree is a real risk, so it is tested as one
thing: `tests/db/loan-engine-parity.test.ts` runs **300 generated loans**
through both and compares them period by period, field by field. If they ever
diverge, that test fails rather than a borrower being quoted one figure at the
counter and charged another.

## The lifecycle

```
draft ──submit──► pending_approval ──approve──► approved ──disburse──► active
  │                     │    │                      │                    │
  │                     │    └──return──► draft     │               (Phase 6)
  │                     │                           │                    ▼
  └──────────────── cancel ───────────────────────────                 cleared
```

| Status | Meaning |
| --- | --- |
| `draft` | Being entered. Freely editable. No figures exist yet. |
| `pending_approval` | Submitted, awaiting a decision. The shape is fixed. |
| `approved` | Decided. Terms computed and frozen, snapshots captured. **The money has not moved.** |
| `active` | Disbursed. The borrower has the money and owes the contractual total. |
| `cleared` | Fully repaid. **Reserved for a later phase** — nothing in Phase 4 performs this transition. |
| `cancelled` | Abandoned before the money moved. Terminal, and retained. |

`in_arrears`, `grace_period` and `overdue` are deliberately **not declared**. A
status nothing can set and nothing can read is a false promise about what the
system knows.

Transitions are enumerated in `loans_guard_transition`, not merely constrained
by a status vocabulary — a `CHECK` on the column says which *values* are legal
and nothing about which *moves* are, and without that a draft could jump
straight to active. `cancelled` and `cleared` are terminal: reviving a
cancelled loan would make a loan nobody approved become active.

### Capability per transition

| Transition | Capability |
| --- | --- |
| draft → pending_approval | `loans:submit` |
| pending_approval → draft (return) | `loans:approve` |
| pending_approval → approved | `loans:approve` |
| approved → active | `loans:disburse` |
| any → cancelled | `loans:cancel` |
| editing a draft | `loans:update_draft` |

Returning a draft needs the *approver's* capability, not the author's: it is a
decision about the loan, made by the person who would otherwise have approved
it.

## Permissions

| Capability | client | secretary_treasurer | manager | owner_admin |
| --- | :-: | :-: | :-: | :-: |
| `loans:view` | | ● | ● | ● |
| `loans:create` | | ● | ● | ● |
| `loans:update_draft` | | ● | ● | ● |
| `loans:submit` | | ● | ● | ● |
| `loans:approve` | | | ● | ● |
| `loans:disburse` | | | | ● |
| `loans:cancel` | | | | ● |
| `loans:view_sensitive` | | | ● | ● |

The lifecycle is split across eight capabilities rather than one
`loans:manage`, because the separation between *entering* a loan, *approving*
it and *releasing the money* is the main internal control a business this size
has. One capability would collapse all three into the same person.

**`loans:disburse` is withheld from the Manager, and this is the phase's
central control.** A Manager also holds `loans:create`. Granting disbursement
as well would let one person originate a loan, approve it and hand over the
cash with nobody else involved. Withholding it means the money is released by
somebody who did not approve it.

**`loans:cancel` is likewise Owner-only**: cancelling an approved loan reverses
a decision, and the person who made it should not be the only one who can
unmake it.

**The Secretary/Treasurer enters loans and decides nothing**, which matches the
business's own description of the role.

**The borrower holds nothing.** Their view of their own loans is a later phase.
The RLS clause is written now and is narrow — own loans only, and only once
approved — but no capability is granted and no interface is exposed.

## Business rules

All of these come from `business_settings`, read server-side. None is a
constant in the engine.

> **Phase 12 changed where most of these are read from.** `business_settings`
> is now the **guard rail**: it bounds what any loan product may offer. A
> loan's own rate, duration, cadence, grace period, penalty and security
> requirements come from its **product**, inside that rail, and are snapshotted
> onto the loan at approval. The one rule below that is still global and only
> global is `max_active_loans_per_client`. See `LOAN-PRODUCTS.md` for the
> precedence rules and how the rail is enforced in both directions.

| Rule | Setting | Current |
| --- | --- | --- |
| Minimum loan | `min_loan_amount` | UGX 100,000 |
| Maximum loan | `max_loan_amount` | UGX 20,000,000 (nullable — NULL means no ceiling) |
| Monthly interest | `default_monthly_interest_rate_bps` | 1500 (15%) |
| Term range | `min_loan_term_months`, `max_loan_term_months` | 1 to 3 |
| Multi-month threshold | `multi_month_min_amount` | UGX 200,000 |
| Guarantors required | `min_guarantors_required` | 1 |
| Active loans per client | `max_active_loans_per_client` | 1 |
| Grace period | `grace_period_days` | 3 (recorded, unused in Phase 4) |
| Penalty rate | `penalty_rate_bps` | 5000 (recorded, unused in Phase 4) |

### The multi-month rule

At or above `multi_month_min_amount` a loan **may** run for two or three
months. Below it, one month. The longer period is *available*, not automatic —
a UGX 600,000 loan can still be a one-month loan if that is what was agreed.

### The guarantor count

The business has not fixed this number, so it is a setting with a deliberately
modest default of **one** rather than an invented constant. One is the smallest
number that makes the guarantor requirement real; the business raises it
without a deployment when it decides to.

### The maximum loan

`max_loan_amount` is nullable and NULL is honoured as "no ceiling". The seeded
value is UGX 20,000,000, carried over from Phase 1 rather than invented here.

## Eligibility

`public.validate_loan_for_approval(loan_id)` returns machine-readable failure
codes, or no rows when the loan may be approved. One function, so the approval
path, the approval screen and the tests ask the same question and get the same
answer:

| Code | Meaning |
| --- | --- |
| `client_not_active` | The client is not `active` (Phase 3's `canBorrow` rule) |
| `active_loan_exists` | The client has reached the active-loan limit |
| `below_minimum` / `above_maximum` | Outside the configured amounts |
| `term_not_permitted` | Outside the configured term range |
| `term_requires_higher_amount` | Multi-month below the threshold |
| `frequency_not_permitted` | Not an active repayment frequency |
| `insufficient_guarantors` | Fewer active guarantors than required |
| `guarantor_incomplete` | A guarantor is missing a phone, occupation, location, relationship or NIN |

**Every rule is re-evaluated at approval**, never carried forward from when the
draft was entered. A client blacklisted between drafting and approval stops the
approval; so does a guarantor detached in between, or a minimum raised in
between. Those races are tested in `tests/db/loan-lifecycle.test.ts`.

## The settings-race policy

> A draft entered at 15%, approved after the Owner moved the rate to 12%, is
> approved **at 12%**.

Terms are snapshotted **at approval, from the settings in force at approval**,
after revalidating the loan against them.

The reasoning: the rate quoted at the counter is not binding — the approval is.
Approving at a stale rate would mean the business lending at a rate it had
already decided to stop offering, with no record of having decided to.

The cost is that a reviewer may approve figures that differ from the ones the
Secretary saw. So the approval screen re-reads the authoritative figures before
asking for confirmation, and the preview is labelled as a preview throughout.
If the business later wants draft-time rate locking, that is an explicit
feature, not an accident.

## The one-active-loan rule

Enforced by `loans_enforce_active_limit`, a BEFORE UPDATE trigger that fires
whenever a loan becomes `active`:

1. take `pg_advisory_xact_lock` keyed on the client;
2. count that client's active loans;
3. refuse if the count has reached `max_active_loans_per_client`.

**Why a trigger with an advisory lock, and not a partial unique index.** An
index on `(client_id) where status = 'active'` would enforce exactly one and
nothing else — which would make `max_active_loans_per_client` a lie the moment
anybody raised it to two: the column would say two, the database would allow
one, and whoever changed it would get a unique-violation they could not
explain. The rule is enforced against the setting, at whatever value it holds,
and `tests/db/loan-concurrency.test.ts` proves it honours a limit of two as
well as one.

The lock is what makes it correct under concurrency. Without it, two
transactions could each count zero and each proceed — the classic
check-then-insert race. The lock is held until commit and released
automatically, including on rollback, and it is keyed on the client so loans
for different borrowers do not contend.

It fires on **any** path to `status = 'active'`, including a direct `UPDATE`,
so bypassing `disburse_loan` gains nothing. The limit is also checked at
*approval*, so a reviewer is told why rather than approving a loan that can
never be disbursed.

## Snapshots

Phase 3 left this as an explicit obligation. A client moves; a guarantor
changes their number; the Owner raises the rate. If a loan file read through to
the live records, every one of those ordinary edits would silently rewrite what
the business claims it was told — in exactly the dispute the file exists for.

| Table | Contents | Readable by |
| --- | --- | --- |
| `loan_periods` | The contractual monthly breakdown | With the loan |
| `loan_client_snapshots` | The client as they were | `loans:view`, or the borrower themselves |
| `loan_guarantor_snapshots` | Each active guarantor as they were, with relationship | `loans:view` |
| `loan_identity_snapshots` | Every NIN captured, client and guarantor | **`loans:view_sensitive`** |

### Why the identity snapshot is separate

Phase 3's central decision (ADR-018) was that a NIN lives behind its own
policy, because PostgreSQL cannot restrict columns to *application* roles —
every signed-in user is `authenticated`, so a NIN column on a broadly readable
table is protected by nothing but the interface not selecting it.

Copying NINs onto a loan readable by anyone with `loans:view` would undo that
in one line: a Secretary/Treasurer who cannot read a client's NIN would simply
read it off the loan instead. So they go into their own table behind
`loans:view_sensitive`, which only the Manager and the Owner hold.

### Immutability

All four tables are **append-only**, enforced twice: a statement-level BEFORE
trigger refuses `UPDATE` and `DELETE`, and no session holds the privilege
either. Statement-level matters — a row-level trigger does not fire for an
`UPDATE` matching no rows, so a wrong-id update would succeed silently and look
like it had worked.

Nothing in the application can write a snapshot: they are written exclusively
by `approve_loan`, which runs as the table owner. So a stored snapshot is
always one the database captured.

`tests/db/loan-snapshots.test.ts` does the four things the specification asks:
approve a loan, then change the client's details, the guarantor's details and
the interest settings — and proves not one figure moved, while confirming the
live records really did change.

## Term immutability

Two different rules, and conflating them is a mistake worth naming:

**Never changes once the loan leaves draft** — what the loan *is*: client,
principal, term, repayment frequency, currency, intended date. Approval does
not touch any of it; it only decides.

**Written exactly once, at approval** — what the loan *costs*: the rate, the
method, the totals, and the policy snapshot. These are genuinely absent until
approval computes them, so the freeze begins at approval rather than at
submission.

Both bind every caller, including `service_role` and the table owner, because
they sit above the trusted-path exemption. A mistake found after approval goes
through cancellation and reissue, where it leaves a trail, rather than being
quietly corrected.

A direct `UPDATE` to `status = 'approved'` cannot succeed in any case:
`loans_approved_requires_totals` demands figures only `approve_loan` can
compute.

## Attribution

Every lifecycle transition stamps its actor from
`public.current_profile_id()`, and a supplied value is **refused** rather than
overwritten — a caller that believes it is choosing the actor should find out.

The constraints require that actor to be present, which has a consequence worth
stating plainly: **there is no such thing as a system-performed approval.**
Approving a loan and releasing money are human acts, and a financial record
that cannot name who performed them is not worth keeping. Even the test
fixtures impersonate a real user, because the schema leaves them no choice.

## Row Level Security

| Table | anon | client | secretary_treasurer | manager | owner_admin |
| --- | --- | --- | --- | --- | --- |
| `loans` | nothing | own, non-draft (read) | register, drafts | + approve | + disburse, cancel |
| `loan_periods` | nothing | with the loan | with the loan | with the loan | with the loan |
| `loan_client_snapshots` | nothing | own | read | read | read |
| `loan_guarantor_snapshots` | nothing | **nothing** | read | read | read |
| `loan_identity_snapshots` | nothing | **nothing** | **nothing** | read | read |

A borrower cannot see a draft: that is the business thinking aloud, and showing
it would let them watch a loan being considered and read a review note written
about them. They cannot see guarantor data at all — a guarantor's details are
that person's data, disclosed to the lender, not to the borrower who named
them.

`loan_periods` delegates rather than restating: its policy tests
`exists (select 1 from public.loans ...)`, and that sub-select is itself
subject to the policy on `loans`. Delegating is the stronger choice — the
alternative is a second copy of the loans rule, including its borrower
self-clause, which could drift.

**No table has a DELETE grant.** Not for any role. Financial history persists;
a loan is cancelled, never deleted.

## Audit

| Action | When |
| --- | --- |
| `loan.created` | A draft is started |
| `loan.updated` | A draft is edited |
| `loan.submitted` | Sent for approval |
| `loan.returned_to_draft` | Returned for correction |
| `loan.approved` | Approved |
| `loan.terms_locked` | The exact terms that became immutable |
| `loan.snapshot_created` | Each snapshot, by kind and row count |
| `loan.disbursed` | The money released |
| `loan.cancelled` | Cancelled, with the reason |
| `loan.cleared` | Reserved for a later phase |

The commercial figures are recorded **in full** — they are the agreement, and a
dispute about what was approved is what the trail is for.

No identity data and no snapshot contents are recorded. `audit:view` is a
broader capability than `loans:view_sensitive`, so dumping a snapshot into
audit metadata would hand every NIN the business ever captured to anyone who
can read the trail. A snapshot event records its kind and how many rows, and
nothing else.

## Cancellation

Permitted from `draft`, `pending_approval` and `approved` — before the money
moves. An **active loan cannot be cancelled**: it has been paid out, and
reversing that is a write-off, which is a different act with different
accounting and belongs to a later phase.

A reason is required, enforced by `cancel_loan` and by
`loans_cancelled_requires_reason`. A cancelled loan stays in the register.

## Phase 5 handoff

Phase 5 is the repayment schedule engine. It can consume, immutably:

| What | Where |
| --- | --- |
| Approved and disbursed loans | `loans.status = 'active'` |
| Principal | `loans.principal_amount` |
| Contractual monthly breakdown | `loan_periods`, ordered by `period_number` |
| Total expected repayment | `loans.total_expected_repayment` |
| **Actual** disbursement date | `loans.disbursed_at` |
| Loan term | `loans.loan_term_months` |
| Selected repayment frequency | `loans.repayment_frequency` → `repayment_frequencies.interval_days` |
| Grace period and penalty rate as agreed | `loans.grace_period_days_applied`, `penalty_rate_bps_applied` |
| Client identity as relied upon | `loan_client_snapshots` |

Two things to be careful about:

1. **Schedule from `disbursed_at`, not `proposed_disbursement_date`.** The
   proposed date is a plan; the borrower received the money on the actual one.
2. **`loan_periods` is the contract, not the collection plan.** It is the
   month-by-month agreement. Phase 5 turns it into actual collection dates at a
   daily, two-day or three-day rhythm. Conflating them would mean treating a
   monthly obligation as a single payment.

Phase 4 adds no balance columns — no `amount_paid`, `remaining_balance` or
`arrears_balance`. Nothing posts payments yet, so such a column could only hold
a zero that looks like a fact.

# Phase 5 — the repayment collection schedule

## The contract and the collection plan

This distinction runs through everything below.

| | Holds | Written by | Changes |
| --- | --- | --- | --- |
| `loan_periods` | The month-by-month reducing-balance **agreement** | `approve_loan` | Never |
| `loan_installments` | How each month is actually **collected** | `generate_loan_schedule` | Never |

The schedule *allocates* the contract. It never restates it, and it never
recalculates interest — interest is contractually fixed at approval, and
recomputing it daily would be a different loan.

## Tables

| Table | Purpose |
| --- | --- |
| `loan_schedules` | One row per loan: the cadence, its interval in days, the disbursement calendar date, the timezone used, the generator version, and who released the money. The primary key on `loan_id` is what makes generation idempotent. |
| `loan_installments` | Each scheduled collection: its date, which contractual month it gathers from, and the principal and interest it gathers. |

Both are append-only. Neither carries payment state. See ADR-026.

## Generation timing and atomicity

The schedule is generated **inside the disbursement transaction**, by
`disburse_loan` calling `generate_loan_schedule` after the status update — it
needs the `disbursed_at` the transition trigger has just stamped.

So there is no such thing as:

* an active loan with no schedule,
* a partial schedule,
* a schedule for a failed disbursement.

If generation raises for any reason — a cadence too infrequent for the
contractual months, a reconciliation failure, a missing timezone — the whole
transaction rolls back: the loan stays `approved`, no installment survives, and
the `loan.disbursed` audit entry rolls back with it. There is no misleading
success left in the trail.

Generation is **idempotent**: a second call finds the schedule already there,
returns it, and inserts and audits nothing.

## The date rules

### Where the schedule is anchored

`loans.disbursed_at`, converted to the **Africa/Kampala calendar date** using
`company_settings.timezone`. Never `proposed_disbursement_date`: one is a plan
that may have slipped, the other is when the borrower took possession of the
money.

The timezone conversion matters. A disbursement stamped `22:30 UTC` happened at
`01:30` the next morning in Kampala, and anchoring on the UTC date would shift
every collection back a day.

### Period windows

Contractual month *n* occupies:

```
[ D + (n-1) months ,  D + n months )
```

where `D` is the disbursement calendar date. **Start inclusive, end
exclusive.** Exclusive is what stops one calendar date belonging to two
adjacent months and producing two collections on one day — and
`loan_installments_unique_due_date` is the backstop that would catch it if the
rule were ever broken.

### Month-end behaviour

Both boundaries are **anchored on `D`**, never stepped from the previous
boundary, and the month addition **clamps** to the end of the target month:

```
31 Jan + 1 month → 28 Feb   (29 Feb in a leap year)
31 Jan + 2 months → 31 Mar  ← anchored, so the 31st returns
31 Aug + 1 month → 30 Sep
```

Stepping would give `31 Jan → 28 Feb → 28 Mar`, losing the 31st permanently and
dragging every later boundary of a long loan earlier. This is exactly what
PostgreSQL's `date + interval 'n months'` does, which matters because the
database is the authoritative generator; `addBusinessMonths` in
`lib/domain/datetime.ts` implements the same rule and
`tests/db/schedule-parity.test.ts` proves they agree.

### The first collection

**One interval after disbursement**, never on the disbursement date itself:

| Frequency | Disbursed | First due |
| --- | --- | --- |
| Daily | 10 Oct | 11 Oct |
| Every 2 days | 10 Oct | 12 Oct |
| Every 3 days | 10 Oct | 13 Oct |

### The cadence

Collections fall on `D + k × interval` for k = 1, 2, 3, …, each assigned to the
one window containing it, stopping strictly before the final boundary.

Building one global cadence and *assigning* it — rather than restarting the
rhythm inside each month — is what guarantees the dates are strictly
increasing, never duplicated and never spilled past the contract, without any
of those needing to be arranged separately.

It also means a month can get a different number of collections than its
neighbours, which is correct. **Nothing assumes 30-day months**: a 600,000
three-month daily loan disbursed on 10 October gets 30, 30 and **31**
collections, not 90.

### No collection, no disbursement

A contractual month that would receive no collection fails generation, and
therefore fails the disbursement. Unreachable at the three cadences the
business offers — the shortest calendar month is 28 days — but reachable the
moment an administrator configures a 40-day rhythm, and the alternative is an
active loan carrying a month of obligation that nothing ever gathers.

## The money rules

Each window's collections split that month's **own** principal and **own**
interest:

```
part(i) = amount / count + (1 if i > count - amount % count else 0)
```

All integer `bigint` arithmetic — the same rule as
`divideEvenly(amount, parts, { remainder: 'last' })`, asserted equal in the
parity test. No floating point anywhere; `npm run audit:money` enforces it.

Any remainder lands on the **final collections of the same month**. A remainder
never crosses a month boundary, so every contractual month reconciles
independently to its own obligation — which is the stronger guarantee, because
a loan total can balance while two months are wrong in opposite directions.

`expected_amount = scheduled_principal + scheduled_interest` on every row, by
CHECK constraint.

### Worked example

UGX 200,000 over 2 months at 15%, daily, disbursed 10 October:

| | Month 1 | Month 2 |
| --- | --- | --- |
| Window | 10 Oct – 10 Nov | 10 Nov – 10 Dec |
| Collections | 30 (11 Oct – 9 Nov) | 30 (10 Nov – 9 Dec) |
| Contractual obligation | 130,000 | 115,000 |
| Principal per collection | 3,333 × 20 then 3,334 × 10 | same |
| Interest per collection | 1,000 | 500 |

Total collected: 245,000 — the contractual total exactly.

## Frequency snapshot

`repayment_frequencies.key` and `interval_days` are **immutable**, and the
cadence is also snapshotted onto `loan_schedules` at generation. See ADR-027
for why both.

## Scheduled completion date

The **final installment's due date**, exposed on the loan detail screen and
recorded in the `loan.schedule_generated` audit event as
`scheduled_completion_date`.

Phase 7 builds loan expiry, grace periods and penalties on this. It is derived
from the schedule rather than approximated as "disbursement plus the term",
because those differ: a three-month loan disbursed on 10 October has its final
collection on 7 or 9 January depending on the cadence, not on 10 January, which
is the exclusive boundary of the third month.

## Permissions

| Capability | client | secretary_treasurer | manager | owner_admin |
| --- | :-: | :-: | :-: | :-: |
| `schedules:view` | | ● | ● | ● |

One capability, not a `view` / `view_all` pair: a schedule is visible exactly
when its loan is, and every staff role that reads schedules already reads the
whole register, so the two would grant the same thing under different names.

A borrower reads their own schedule through the ownership clause in the policy,
not through a capability.

There is **no** create, edit or delete capability. The schedule is generated by
the database and is then contractual history.

## Row Level Security

| Role | `loan_schedules`, `loan_installments` |
| --- | --- |
| anon | nothing |
| client | their own loan's schedule |
| secretary_treasurer | every schedule they can see the loan for |
| manager | the same |
| owner_admin | the same |

Both policies **delegate** to the loans policy —
`exists (select 1 from public.loans l join public.clients c … )` — rather than
restating it, so a change to loan visibility cannot leave a stale copy behind.

SELECT is the only grant. There is no write policy and no write privilege for
any session role, and `generate_loan_schedule` is not granted to
`authenticated` at all: the only legitimate caller is `disburse_loan`, which
runs as the table owner.

## Phase 6 handoff

Phase 6 — payments, balances, receipts and reversals — can safely consume:

| Needs | Where |
| --- | --- |
| Immutable installment ID | `loan_installments.id` |
| The loan and, through it, the client | `loan_installments.loan_id` → `loans.client_id` |
| Due date | `loan_installments.due_date` (a `date`, in business time) |
| Expected amount | `loan_installments.expected_amount` |
| Principal and interest components | `scheduled_principal`, `scheduled_interest` |
| Contractual month | `loan_period_id`, `loan_period_number` |
| Contractual total | `loans.total_expected_repayment` |
| Scheduled completion date | the last `due_date` for the loan |

Three things for Phase 6 to hold to:

1. **Never update an installment row.** Payment state belongs in Phase 6's own
   structures. The triggers will refuse anyway, but the design should not want
   to.
2. **The schedule says what is *due*, not what was collected.** Any "paid",
   "missed" or "outstanding" figure is Phase 6's to derive and own.
3. **Arrears never rewrite the plan** (Phase 7). Monday's UGX 4,000 row stays
   UGX 4,000 whatever happens on Tuesday. See ADR-026.

# Phase 6 — payments, balances, receipts and reversals

Phase 5 produced the collection plan: immutable rows saying what is due and
when. Phase 6 records what the borrower actually hands over, works out what
that covers, and answers "what is still owed" — without touching the plan.

## The payment model

Two tables, both append-only.

| Table | Holds |
| --- | --- |
| `loan_payments` | one row per payment received: amount, method, reference, who took it, when, the receipt figures, its status |
| `payment_allocations` | one row per collection a payment was applied to, with the principal and interest components |

A payment is posted by `public.post_payment(loan, amount, method, reference,
idempotency_key, notes)`, which does all of this in one transaction:

1. locks the loan row and the idempotency key;
2. returns the existing payment if that key has already been used (ADR-030);
3. re-derives the loan's position from the schedule and the existing
   allocations — never from anything the caller supplied;
4. validates the amount against the minimum and the outstanding cap;
5. inserts the payment, then its allocations in one `insert ... select`;
6. reconciles: allocations sum to the amount, no collection is over-covered,
   outstanding has not gone negative;
7. clears the loan if nothing remains outstanding.

`received_at` is database time. A clock the client controls would decide which
collections a payment covers.

### Payment methods

`cash`, `mtn_mobile_money`, `airtel_money`. Phase 6 records the method; it does
not talk to either network — MTN and Airtel integration is a later phase.

A Mobile Money payment **requires** a transaction reference, and
`(payment_method, external_reference)` is unique among posted payments, so the
network's own identifier cannot be recorded against two payments. A cash
payment **must not** carry one: cash has no network reference, and inventing a
field for it would invite a staff member to type the receipt number into it.
Cash duplicate protection is the idempotency key instead.

### Status

`posted` or `reversed`. There is no `pending`: this phase records money already
in hand. See ADR-028.

## Allocation

**Oldest collection first, interest before principal within each collection.**

```
for each collection, by due date then installment number:
    take      = min(what the collection still needs, what is unallocated)
    interest  = min(the collection's uncovered interest, take)
    principal = take - interest
```

Every component is a `min()` of two integers, so `principal + interest = take`
exactly — no division, no rounding, no remainder to place. ADR-031 explains why
this was chosen over pro-rata; `tests/db/payment-parity.test.ts` proves the SQL
and the TypeScript agree payment by payment.

### The minimum payment

**The remaining amount of the earliest uncovered collection.** A smaller
payment is refused, with a message naming the figure.

The rule exists so that part-payments cannot accumulate into a mess where no
collection is ever settled. It is also the figure the payment form prefills,
because it is usually what the borrower has come to pay.

### Overpayment

A payment may cover several collections, including future ones: UGX 10,000
against three UGX 4,000 collections covers the first two and 2,000 of the
third. That is what a borrower paying ahead means.

**A payment is capped at the outstanding balance.** More than that is refused
rather than held as a credit. Phase 6 creates no client credit balances: a
balance nobody has decided the rules for is worse than a refusal the staff
member can act on immediately.

### Clearance

When the last shilling is covered the loan moves `active → cleared`, stamped
with who took the final payment. The transition is validated against the
derived ledger and refused if anything remains outstanding — including for
`service_role`. See ADR-032.

Reversing a payment on a cleared loan reopens it, through the same validated
path.

## Balances

Three views, all `security_invoker`, so a reader sees only loans their own
policies let them see.

| View | Answers |
| --- | --- |
| `loan_installment_coverage` | per collection: expected, covered, remaining |
| `loan_balances` | per loan: total paid, outstanding, principal and interest paid and remaining, payment counts, whether it is fully repaid |
| `payment_collection_totals` | per day and method: what was collected |

Everything is derived on read from the contract and the allocations of
**posted** payments. There is no stored balance column, so:

* a reversal changes every figure the instant it commits, with no cache to
  invalidate;
* nothing can disagree with the ledger;
* `outstanding` cannot go negative — it is `scheduled_total - total_paid`, and
  `post_payment` refuses any amount that would overshoot.

Money columns are `bigint` throughout. `sum(bigint)` returns `numeric` in
PostgreSQL, so every aggregate is cast back; `tests/db/schema.test.ts` checks
the view columns' types for exactly this reason.

`getLoanPosition` re-checks every balance invariant against the figures it has
just read, and reports a `reconciles` flag with the problem. It should be
unreachable — the posting function reconciles before it commits — which is why
the screen surfaces it loudly if it ever appears, and tells staff not to quote
the figure. Deliberately not a view column: it is a statement about figures a
reader has in hand, and computing it beside them is what makes it a check
rather than another derived number to trust.

## Receipts

A payment's number (`PAY260001`, from the Phase 1 reference sequence) **is** its
receipt number. There is no second numbering: two identifiers for one event
would eventually disagree.

`outstanding_before` and `outstanding_after` are frozen onto the payment at
posting, with a `CHECK` enforcing `after = before - amount`. They are a record
of what the receipt said at the counter, not a balance anybody reads to answer
what is owed. ADR-029 explains the distinction, and the bug it prevents.

Immutable after posting: amount, method, reference, loan, the receipt figures,
`received_at`, `recorded_by`, the idempotency key, and every allocation. The
only permitted change is `posted → reversed`, and even that is refused unless
the database can name the actor.

A reversed receipt is marked `REVERSED`, shows the reason and the date, and
still shows every original figure.

## Reversal

`public.reverse_payment(payment, reason)`:

* requires `payments:reverse` — the Owner alone;
* refuses a payment already reversed;
* requires a reason of at least ten characters;
* captures the live outstanding balance, flips the status, then asserts the
  balance rose by exactly the payment's amount;
* reopens the loan if it had been cleared.

The payment, its amount, its receipt figures and all of its allocations are
preserved. Nothing is deleted, and no negative entry is posted. See ADR-028.

## Permissions

| Capability | Client | Secretary/Treasurer | Manager | Owner/Admin |
| --- | --- | --- | --- | --- |
| `payments:view` | — | ✓ | ✓ | ✓ |
| `payments:create` | — | ✓ | ✓ | ✓ |
| `payments:reverse` | — | — | — | ✓ |

A borrower sees their **own** payments through the portal, by row ownership
rather than by capability — the same mechanism Phase 3 used for their profile.

There is no capability to edit a payment, to edit an allocation, or to delete
either, for any role. Owner included. Those operations do not exist in the
schema, so no grant could reach them.

## Row Level Security

| Table | `authenticated` privileges | Policy |
| --- | --- | --- |
| `loan_payments` | SELECT only | the loan is visible **and** (`payments:view` or the borrower is you) |
| `payment_allocations` | SELECT only | delegated entirely to the payment |

Writes go through the two `SECURITY DEFINER` functions, which check the
capability themselves. `authenticated` holds no INSERT, UPDATE or DELETE on
either table, so there is no direct-write path to close.

The views are `security_invoker`, which means they are read under the reader's
own policies rather than their owner's. Without that a view would quietly
bypass every policy on its base tables. `tests/db/schema.test.ts` asserts the
flag is set on all three, and that none of them is readable by `anon`.

## Phase 7 handoff

Phase 7 adds missed-payment carry-forward, arrears, the three-day grace period
and the 50% penalty. What Phase 6 deliberately leaves to it:

1. **No arrears anywhere.** The only figure of that shape is
   `unpaidScheduledDue`, derived from the coverage view against today's
   business date — the sum of scheduled amounts dated today or earlier that
   remain uncovered — and the screens call it "due now". Whether that is *arrears* depends on a grace
   period and carries a penalty; naming it arrears now would be a judgement
   about a borrower on no basis.
2. **No doubled next payment, no overdue state, no penalties.** The schedule
   stays as agreed and the minimum payment rule is purely "the earliest
   uncovered collection".
3. **The schedule is still untouched.** Arrears will be a separate fact about
   what happened to the plan, computed from the plan and the allocations —
   neither of which Phase 7 needs to rewrite.
4. **Penalties will be their own obligations**, not edits to installment
   amounts. The allocation engine takes a list of obligations; a penalty is
   another obligation in that list.

# Phase 7 — missed payments, arrears, grace and penalties

Phase 5 generated the plan and Phase 6 recorded the money. Phase 7 answers the
question those two leave open: **what should have been paid by now, and
hasn't** — and what it costs a borrower whose loan runs past its end.

## What a missed payment is, and what it is not

A missed payment is a scheduled collection whose due date has passed and which
posted payments have not covered. That is all it is: **an observation about the
plan and the ledger**, not an event, not a status and not a change to the
plan.

So nothing is rewritten when a borrower misses a collection:

* `loan_installments` stays exactly as generated. The row for the missed day
  keeps its due date and its UGX 4,000, because that is what the borrower
  agreed to and it is the evidence of the agreement (ADR-026).
* No interest is added. A missed payment makes nothing larger. The contractual
  interest was fixed at approval (ADR-021) and Phase 7 does not recompute it,
  compound it, or charge anything per day. The *only* additional charge in the
  whole phase is the single expiry penalty below.
* No arrears figure is stored anywhere. See ADR-033; the schema is asserted
  free of such a column.

What *does* change is a derived figure: the borrower now owes two collections
instead of one.

## The three figures

Computed by `loan_delinquency`, as at today in the business timezone:

| Figure | Definition |
| --- | --- |
| `arrears_amount` | Uncovered amount of every collection due **strictly before** today |
| `due_today_amount` | Uncovered amount of collections due **today** |
| `current_due` | The two added — what a collection officer asks for |

"Uncovered", not "scheduled": a collection part-covered by an earlier
overpayment contributes only what is actually left of it, so money already
received is never asked for twice.

This is the carry-forward. A borrower on UGX 4,000 a day who misses Monday
owes UGX 8,000 on Tuesday — `arrears_amount` 4,000 plus `due_today_amount`
4,000 — **with both scheduled rows untouched**. Tuesday's installment is still
a UGX 4,000 installment. The borrower is simply behind by one.

A payment on the due date is on time. The comparison is `due_date < today` for
arrears, so a collection becomes overdue at the start of the following day and
not a moment earlier.

## Two measures of lateness, never conflated

* `missed_installment_count` — how many past collections are still uncovered.
* `days_past_due` — calendar days from `oldest_past_due_date` to today.

They are different numbers, and the difference matters operationally. On an
every-3-days schedule, three missed collections are **nine days** late.
Reporting the count as "days overdue" would overstate a borrower's lateness
threefold, which on a collections list is the difference between a phone call
and a visit. Both figures are shown, each with its own label.

Neither is capped and neither saturates: a loan 400 days late reports 400.

## Expiry, grace and the penalty date

A loan **expires** at its contractual completion date, which is the due date
of its final installment — `max(loan_installments.due_date)`, exactly as Phase
5 defined it. It is deliberately not recomputed from the disbursement date and
the term: the schedule already resolved every month-end and leap-year
question, and a second calculation would eventually disagree with the
collections the borrower was actually given.

After expiry the loan gets a **grace period**, taken from the loan's own
snapshotted `grace_period_days_applied` and never from the current business
setting (ADR-023). Changing the setting today must not move the penalty date
of a loan approved last year.

```
grace_end_date         = final_due_date + grace_period_days
penalty_effective_date = grace_end_date + 1
```

With a final collection on **10 Oct** and three days of grace: grace runs
11–13 Oct, and the penalty becomes applicable on **14 Oct**, from the start of
that day. A loan settled in full on 13 Oct is never charged.

`within_grace_period` is true strictly between the final due date and the
grace end, and only while something is still owed. During grace the loan is
not "in default" — it is late, with the business's own allowance still
running, and the screens say so.

## The penalty

One charge, with a rule that fits in a sentence: **a loan still unpaid at the
end of its grace period is charged 50% of what it owed when the grace period
ran out.**

Every part of that is deliberate.

**50% comes from configuration as basis points**, snapshotted onto the loan as
`penalty_rate_bps_applied`. There is no `0.50` anywhere in the system. 50% is
`5000` bps, and the arithmetic is integer throughout:

```
penalty_amount = (basis_amount × penalty_rate_bps + 5000) / 10000
```

The `+ 5000` is half-up rounding to the whole shilling, in integer division —
the same rule and the same shape as every other rate in the system
(ADR-020). No floating point touches money anywhere in Phase 7, which
`npm run audit:money` enforces across 37 files and all four engines.

**The basis is the effective debt as at the end of the grace period**, not
today's balance — reconstructed by `loan_outstanding_as_of(loan, date)`, which
counts only still-posted payments whose *business date* falls on or before
that date. If the basis were read whenever the charge was finally written, a
borrower who paid most of the debt on day six would be charged on the
remainder, and the later they paid the less they would owe. The incentive
would be exactly backwards. Reversed payments never reduce the basis: the
money was withdrawn, so it never really paid.

**It is charged once.** A unique index on `(loan_id, penalty_type)` makes the
one-time rule a property of the database rather than a convention: not 50% a
day, not 50% a month, and never a penalty on the penalty.

**It is immutable.** `loan_penalties` refuses UPDATE and DELETE for every
caller including `service_role`, and `penalty_amount` is re-derived from the
stored basis and rate by a CHECK constraint — so a *forged* penalty amount is
impossible, not merely unauthorized. There is no capability to create, edit,
delete or waive a penalty, and no user-entered penalty amount anywhere: the
figure is the rule applied to the ledger.

Each row carries its complete provenance — the final due date, the grace days,
the basis, the rate, the effective date, the trigger rule and when it was
applied — so anyone can reconstruct the arithmetic from the row alone.

## Where the penalty comes from, with no scheduled job

Eligibility is **derived continuously**: `loan_delinquency.penalty_eligible`
becomes true the moment the business date reaches the penalty date, with no
process involved at all. Materialisation — writing the row — happens at the
two moments it has to:

* **`post_payment` calls `ensure_penalty_applied` before it reads a balance**,
  so a borrower cannot settle yesterday's figure and escape a charge that was
  already due. This is the path that matters.
* **`reverse_payment` calls it after reconciling**, so a loan whose exemption
  rested on money that has now been withdrawn does not stay exempt.

`apply_eligible_penalties()` exists for a future scheduled sweep, and is an
optimisation rather than a dependency. Financial correctness never waits for
cron.

A read materialises nothing. A SELECT must not write — it may run in a
read-only transaction, as a borrower, or under a role with no privileges on
`loan_penalties` — so screens display the *projected* charge from the view,
labelled as pending, and the transaction that needs the row to exist creates
it. `ensure_penalty_applied` takes the loan's row lock first, so two
concurrent payments produce one penalty; the second call returns the first
one's row.

## Delinquency states

One operational state per loan, by a fixed precedence, so a loan can never
present two at once:

| State | Meaning |
| --- | --- |
| `cleared` | Owes nothing at all, penalty included |
| `penalty_due` | A penalty is recorded and not fully paid |
| `expired_unpaid` | Past the penalty date and eligible, not yet materialised |
| `grace_period` | Past the final due date, inside grace, still owing |
| `in_arrears` | A collection before today is uncovered |
| `due_today` | Nothing overdue, but today's collection is uncovered |
| `current` | Nothing owed today or earlier |

This is **not** a loan status. `loans.status` remains the lifecycle
(`draft → pending → approved → active → cleared`), stored and transitioned by
audited acts. Delinquency is derived, so midnight changes it with no
transition, no trigger and no event.

## Balances, after penalties

`loan_balances.outstanding` is **renamed** `contractual_outstanding`, with no
alias kept. With penalties in the system a figure called "outstanding" that
excludes a charge the borrower owes is a trap, and two names for one number
means a future report quotes the wrong one.

| Column | Meaning |
| --- | --- |
| `contractual_outstanding` | The agreement, unaffected by any penalty |
| `penalty_assessed` / `penalty_paid` / `penalty_remaining` | The charge, apart |
| `total_outstanding` | What the borrower owes: the two together |
| `total_collected` | Everything received, contract and penalty |

`total_paid` keeps its Phase 6 meaning (money applied to the contract), so
`total_paid + contractual_outstanding = scheduled_total` and
`principal_paid + principal_remaining = contractual_principal` still hold
exactly. `total_collected` is what reconciles against `posted_payment_total`.
`fully_repaid` becomes stricter — it now requires the penalty settled — and is
unchanged for every loan without one.

## Allocation with a penalty in the list

Money reaches a penalty through the same `payment_allocations` table, with
exactly one of `installment_id` and `penalty_id` set (ADR-036). There is no
second allocation engine and no second ledger.

The order needs no penalty branch. `loan_obligations` lists collections and
the penalty together, ordered by `effective_date, obligation_rank,
sequence_number`, and a penalty's effective date is necessarily later than
every collection — so ordinary oldest-first settles the whole contract before
touching the charge. Within an obligation the Phase 6 rule stands: interest
first, then penalty, then principal as the remainder.

The minimum-payment rule is restated over obligations rather than
collections — the earliest uncovered obligation's remainder — which means it
is the earliest unpaid collection while the contract stands, and the penalty's
remainder once it does not. An overpayment beyond `total_outstanding` is still
refused with the figure named; no credit balance is ever created, penalty
included.

Receipts gain a penalty line when a payment touches one, and nothing else
about them changes. Historical receipts are untouched: a frozen balance
snapshot from Phase 6 is never retrospectively given a penalty figure, and the
Phase 6 receipts are byte-for-byte identical after the upgrade.

## Reversal

Reversing a payment restores the position exactly, and `ensure_penalty_applied`
runs afterwards:

* A loan that was cleared becomes `active` again, and if its grace period had
  already expired the penalty it escaped is now applied.
* A penalty that already exists is **never recreated, recalculated or
  duplicated** — the unique index would refuse it, and the basis was fixed as
  at the grace deadline so it would not change anyway.
* Penalty allocations stop counting the moment the payment is reversed, in
  exactly the way installment allocations do. The rows stay; the coverage
  disappears.

## Clearance

A loan may not be `cleared` while a penalty is unpaid.
`loans_guard_transition` now validates against `loan_total_outstanding`, which
binds every caller including `service_role` (ADR-032) — so the rule holds for
a direct `UPDATE` as much as for `post_payment`. A loan reaches `cleared` only
when the contract *and* the charge are settled, and a loan that temporarily
looked cleared is not silently exempt from a charge it had already earned.

## The business clock

Every date comparison in Phase 7 goes through `business_date()`, which converts
`business_now()` into a day using the company's configured timezone. Nothing
uses `current_date`, `now()::date`, the server's timezone, a UTC date or the
browser's clock — at 23:30 UTC on the 9th it is already the 10th in Kampala,
and a collection cannot be both overdue and current depending on who looks.

`business_now()` can be overridden, but only on a direct database connection
owned by the schema owner, which no application path has. That is what makes
grace boundaries, month ends and leap days testable. See ADR-034.

## Worked examples

A daily loan of UGX 4,000 a collection, and a 100,000-outstanding loan with
three days of grace and a 5000 bps rate. Every figure below is verified
end-to-end against a real database in `tests/db/` and by the manual
verification script.

| Scenario | Result |
| --- | --- |
| One collection missed | arrears 4,000 · due today 4,000 · **current due 8,000** · missed 1 · 1 day · `in_arrears` |
| Borrower then pays 8,000 | arrears 0 · due today 0 · current due 0 · missed 0 · `current` |
| Two collections missed | arrears 8,000 · due today 4,000 · **current due 12,000** · missed 2 · 2 days |
| Settled in full during grace | no penalty, ever · total owed 0 · `cleared` |
| Grace expires owing 100,000 | basis 100,000 · **penalty 50,000** · contract 100,000 · **total 150,000** · `penalty_due` |
| 40,000 paid during grace, then expiry | basis 60,000 · **penalty 30,000** · contract 60,000 · total 90,000 |
| 40,000 paid *after* the penalty applied | contract 60,000 · penalty still 50,000 · total 110,000 |
| Clearing payment reversed after expiry | `active` · contract 100,000 · penalty 50,000 · total 150,000 · one penalty row, same amount and basis |

The sixth and seventh rows are the same money, days apart, and they differ by
UGX 20,000. That difference is the point of fixing the basis at the grace
deadline.

## Permissions

| Capability | Roles |
| --- | --- |
| `delinquency:view` | Secretary/Treasurer, Manager, Owner/Administrator |
| `penalties:view` | Secretary/Treasurer, Manager, Owner/Administrator |

There is no `penalties:create`, `penalties:edit`, `penalties:delete` or
`penalties:waive`, for anyone, including the Owner. A penalty is the rule
applied to the ledger; if the business ever wants a waiver it will be a new
audited transaction that leaves the penalty standing, not an edit to it.

Borrowers see their own arrears and their own penalty in the portal without
either capability, through the same client link that already shows them their
schedule.

## Row Level Security

`loan_penalties` is enabled, with a single `select` policy that delegates
entirely to the loan: a reader may see a penalty if they hold
`penalties:view`, or if the loan is their own. No `insert`, `update` or
`delete` policy exists for any role, and `authenticated` holds no such
privilege either — so no session reaches the guard triggers at all.

`loan_penalty_coverage`, `loan_obligations`, `loan_balances` and
`loan_delinquency` are all `security_invoker`, so each is read under the
reader's own policies and needs none of its own. Every privilege is revoked
from `public`, `anon` and `authenticated` before SELECT is granted back to
`authenticated` — Supabase's default privileges make that explicit revoke
necessary, as Phase 6 found out.

## Phase 8 handoff

What Phase 7 leaves for later, deliberately:

1. **No notifications.** `loan_delinquency` is the complete input a reminder
   engine needs — state, amount, lateness, penalty date — and it writes
   nothing, so a notification layer can read it on any schedule without
   affecting a single figure.
2. **No scheduled job in the critical path.** `apply_eligible_penalties()` is
   ready for one and will materialise nothing a payment would not have
   materialised anyway. Correctness does not depend on it running.
3. **No reporting beyond the overdue list.** `/overdue` is an operational
   screen — who is late, by how much, how late. Portfolio ageing, recovery
   rates and executive dashboards are Phase 8's.
4. **No waiver, and no second penalty type.** `penalty_type` exists as a
   column so a future charge can be added without touching this one, and the
   unique index is per type.
5. **The contract still untouched.** Seven phases in, no code path alters a
   generated installment, a snapshotted term or a contractual interest figure;
   the upgrade from Phase 6 is fingerprint-identical on all three.

# Phase 8 — reporting

Phase 8 adds no loan rule, no money rule and no table. Dashboards, reports, the
client statement, the portal and the Manager remarks integration are documented
in [REPORTING.md](REPORTING.md), which also carries the definition of every
figure they display.

Two things are worth stating here, in the document about the loan engine,
because they are promises Phase 8 makes about it:

1. **Nothing in the reporting layer calculates money.** Every figure is read
   from `loans`, `loan_balances`, `loan_delinquency` or the payment ledger. The
   one new quantity in the whole phase is `expected_today` — the day's
   collection target as it stood at the start of the day — and it is a
   subtraction between two stored amounts, computed in SQL beside the data. See
   ADR-037.
2. **Nothing in the reporting layer writes.** No route under `/reports` exports
   anything but `GET`, no reporting view is writable by any session role, and a
   report read never materialises a late-payment charge: fifteen reads across
   every reporting view against a loan past its charge date leave
   `loan_penalties` empty. Phase 7 made reads side-effect free and Phase 8
   keeps them that way.

The upgrade is fingerprint-identical on loans, installments, periods, payments,
allocations, charges, balances, snapshots, receipts and the audit trail.

## Test commands

```bash
npm test                 # watch mode
npm run test:run         # pure logic and components: the unit and integration projects
npm run test:db          # against a real PostgreSQL, rebuilt first
npm run verify           # typecheck, lint, format, test:run, build

npm run audit:money      # float-free audit of the loan arithmetic
npm run typecheck
npm run lint
npm run format:check
npm run build

./scripts/pg-local.sh migrate  # rebuild the local database from zero
```

The database suite needs `DATABASE_URL`; `scripts/pg-local.sh url` prints one.
