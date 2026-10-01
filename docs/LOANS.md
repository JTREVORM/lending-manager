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

## Test commands

```bash
npm test                 # everything
npm run test:unit        # pure logic, including the financial engine
npm run test:integration # components, jsdom
npm run test:db          # against a real PostgreSQL, rebuilt first

npm run audit:money      # float-free audit of the loan arithmetic
npm run typecheck
npm run lint
npm run format:check
npm run build

./scripts/pg-local.sh migrate  # rebuild the local database from zero
```

The database suite needs `DATABASE_URL`; `scripts/pg-local.sh url` prints one.
