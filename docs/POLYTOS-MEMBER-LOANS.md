# Polytos member loans — the module

Two tables, two views, three reporting and assessment functions, nine new or
replaced database functions, two capabilities — added by ten migrations
numbered `20261021000100`–`20261021001000`.

Nothing existing was altered destructively: no column was dropped, no
constraint relaxed, no policy widened, and no row of financial history
touched. Three existing functions were **replaced** rather than duplicated —
`generate_loan_schedule`, `validate_loan_for_approval` and `approve_loan` —
because a member loan is a loan, and a second approval path beside the
existing one would be a second set of rules over the same agreement.

`node scripts/verify-membership-upgrade.mjs` applies all three Polytos phases
to a populated book and proves every one of 28 financial figures identical,
including every collection date, loan by loan.

---

## 1. The one thing to get right

A member with UGX 300,000 saved borrows UGX 200,000 against it. There are two
plausible-looking implementations:

```
  Debit  2100 Member Savings       200,000
  Credit 1xxx Loans Receivable     200,000     -- wrong
```

```
  (no journal entry at all)
  insert into member_loan_savings_pledges …     -- right
```

The first treats the savings as collateral that has been *taken*. It nets
nicely, it makes the member's exposure look smaller, and it is wrong in a way
that would be discovered at the worst possible moment: the business still owes
that member every shilling they saved. If the loan is repaid, the savings were
never theirs to spend; if the member dies, the savings are part of their estate
and the loan is a debt against it. Offsetting the two decides, silently and in
advance, a question nobody asked the member.

So: **a pledge restricts, it does not spend.** No journal entry, no savings
transaction, no change to account `2100`. What it changes is how much the
member may *withdraw*, which is `savings_withdrawable_amount` and nothing else.

Every screen that shows a pledge says so in words, because it is the single
most misreadable figure in the system.

---

## 2. Entity relationships

```
   membership_policy_versions ◄──────┐ policy_version_id (frozen)
          (Phase 1)                  │
              │ policy_version_id    │
              ▼                      │
          memberships ───────────────┤
          (Phase 1)   membership_id  │
              │                      │
              │ membership_id        │
              ▼                      │
        savings_accounts ────────────┤
          (Phase 2)   savings_account_id
              │                      │
              │                      │
              ▼                      │
   member_loan_savings_pledges ──────┘
      (one per loan, PK loan_id;
       released_at NULL = live)
              │ loan_id
              ▼
            loans ◄──── member_loan_eligibility_snapshots
       (membership_id,      (one per loan, PK loan_id,
        interest_basis,      append-only, written at approval)
        frozen at approval)
              │ loan_product_id
              ▼
        loan_products
     (requires_membership,
      interest_source)
```

Both new tables are keyed on `loan_id` rather than carrying a surrogate: there
is exactly one assessment a loan was approved on and exactly one pledge
securing it, and a surrogate key would admit a second of either.

Both are **append-only** by statement-level guard trigger. An assessment is
evidence of what the business saw; a pledge is evidence of what it committed.
Neither is a working value to be corrected.

---

## 3. A member loan is a loan

It is written in `loans`, under a product with `requires_membership = true`. It
goes through `approve_loan` and `disburse_loan`, generates a schedule in
`loan_installments`, is collected with `post_payment`, accrues penalties
through `ensure_penalty_applied`, and appears in the loan register, the
delinquency view, the trial balance and every report.

What Phase 3 adds to it is four frozen columns and two rows:

| On the loan | What it holds |
| --- | --- |
| `loans.membership_id` | which membership this was lent against |
| `loans.interest_basis` | `per_month` or `per_loan`, from the member's own version |
| `loans.interest_method` | widened to admit `flat` |
| `loans.loan_product_id` | a product with `requires_membership` |

`loans_guard_member_terms()` freezes `membership_id` and `interest_basis` at
approval, for every caller including `service_role`. A later policy version
does not reprice a loan already written.

There is **no second detail screen**. `/member-loans` lists member loans and
every row opens `/loans/{id}`, where the existing screen carries the approved
terms, the schedule, the payment history and the approval trail, and the
member loan adds a panel. A second screen would be a second set of controls
over one agreement.

---

## 4. Eligibility is a database decision

```
  member_loan_eligibility_of(client_id, as_of)        SECURITY DEFINER,
                                                       no session may call it
        │
        ├── assess_member_loan_eligibility(client_id)  the wrapper, checks
        │                                              member_loans:view_eligibility
        │
        ├── member_loan_eligibility                    the view, security_invoker
        │
        └── validate_loan_for_approval(loan_id)        the control
```

The assessment is one function, called from four places, and the **form is
never the control**. A browser cannot be trusted and a check made when a form
was filled in would be stale by the time somebody approved: another deposit, a
withdrawal, a suspension, a policy published. So `validate_loan_for_approval`
re-evaluates everything from the loan's own figures at the moment of the
decision, and `approve_loan` takes the savings-capacity advisory lock *before*
it validates.

The ceiling:

```
  eligible_savings      the balance member_savings_qualification judged
  − pledged_savings     what live pledges on this account already secure
  − pending_withdrawals what is requested and not yet decided
  ─────────────────────
  available_savings     (floored at zero)
  × multiplier_bps / 10000
  ─────────────────────
  max_eligible_loan     integer division: floors, deliberately
```

Three of those four lines were defects the new tests found, not design:

- the first draft ignored capacity already consumed, so a member could borrow
  twice against the same savings;
- pending withdrawals were not reserved, so a member could request a
  withdrawal and take a loan against the money on its way out;
- the ceiling rounded half-up while the pledge rounds up, which disagreed
  below a 1× multiplier — a loan could be approved whose pledge exceeded the
  savings that justified it.

The floor is deliberate and the pledge's ceiling is deliberate, and they point
the same way: the business never lends a shilling more than the multiplier
supports, and never secures a shilling less.

### The refusal codes

`validate_loan_for_approval` returns a **set** of failure codes, not the
first. An approver is told everything that has to change, not one thing at a
time. Phase 3 adds:

| Code | Means |
| --- | --- |
| `member_product_not_member` | the product requires a membership and this client has none |
| `member_not_active` | the membership is pending, suspended or ended |
| `member_policy_not_open` | the member's own version does not open member lending |
| `member_savings_missing` | no savings account |
| `member_savings_suspended` | the savings account is not active |
| `member_not_qualified` | the qualifying months have not been served |
| `member_amount_above_ceiling` | more than the available savings support |
| `member_term_above_maximum` | longer than the member's own version permits |
| `member_cadence_not_permitted` | the cadence is not the one this term requires |
| `cadence_anchor_undecided` | calendar-monthly, and the anchor is not decided |

The last is **not** member-specific, deliberately: an ordinary loan on a
calendar-monthly cadence hits the same wall, and a member-only code would have
implied otherwise.

---

## 5. The savings pledge

```
  approve_loan
    │
    ├── lock_savings_capacity(savings_account_id)   pg_advisory_xact_lock
    ├── validate_loan_for_approval(loan_id)         re-evaluated here
    ├── insert member_loan_eligibility_snapshots    the evidence
    ├── insert member_loan_savings_pledges          the commitment
    └── assert  sum(live pledges) <= account balance
```

The pledged amount is the savings that *support* this principal, rounded up:

```
  pledged_amount = (loan_principal * 10000 + multiplier_bps - 1) / multiplier_bps
```

That arithmetic is restated as a CHECK constraint on the table, so a pledge
written by any means has to satisfy it. The snapshot's ceiling, qualification
and available-savings arithmetic are CHECK constraints too. A table whose
constraints restate the rules cannot hold a row that contradicts them, whoever
wrote it and however.

The pledge is released by `member_loan_release_pledge()`, an AFTER UPDATE OF
status trigger on `loans`: a pledge returns to the member when the loan stops
being a live obligation, as a **consequence of closure** rather than a step
somebody performs. A release that had to be remembered would be a release that
got forgotten.

`request_savings_withdrawal` takes the same capacity lock and bounds the
request on the pledge where one exists. Two people cannot withdraw and borrow
against the same shilling at the same instant;
`tests/db/member-loan-concurrency.test.ts` runs both races.

---

## 6. The calendar month

"Monthly" in the client's documents means a calendar month, not thirty days. A
loan disbursed on the 15th is collected on the 15th, and
`interval_days = 30` would be a different contract that happens to look
similar.

```
  repayment_frequencies
    cadence_kind    'fixed_days' | 'calendar_month'
    interval_days   NOT NULL for fixed_days, NULL for calendar_month
    month_anchor    NULL for fixed_days; write-once for calendar_month
```

`monthly_collection_date(anchor_date, months, month_anchor)` is the whole
convention, and it has two arms because the client has not chosen between
them:

| Anchor | A loan disbursed 31 January, collected at month 1 |
| --- | --- |
| `clamp_to_month_end` | 28 February (PostgreSQL's own month arithmetic) |
| `roll_forward_to_next_month` | 1 March |

Both are implemented, both are tested, neither is a default. The `monthly`
cadence ships **inactive** with a NULL anchor, `generate_loan_schedule` raises
rather than guessing, and `validate_loan_for_approval` returns
`cadence_anchor_undecided`. See ADR-059 for why the anchor lives on the
cadence rather than becoming a tenth policy question.

### The fixed-day arm is byte-identical

`generate_loan_schedule` gained a second arm and its first arm was copied
character-for-character. `generator_version` stays `1` for `fixed_days` and is
`2` only for `calendar_month`, because the fixed-day rules did not change and a
bumped version would have claimed they did.

`tests/db/schedule-parity.test.ts` and the `installment_schedule` figure in
`scripts/verify-membership-upgrade.mjs` both assert it from outside: every
existing schedule's every date, loan by loan, unchanged across the migration.

---

## 7. Pricing, and the three decisions nobody has made

A member loan's rate, basis and method come from **the borrower's own frozen
policy version**, not from the product. `loan_products.interest_source =
'membership_policy'` is what says so, and `capture_loan_product_snapshot`
never records a policy-priced loan as a rate override.

The confirmed figure is 5% — `member_loan_interest_rate_bps = 500`, NOT NULL on
every version, taken from the client's own documents. What is *not* decided is
what that 5% is applied to:

| Question | Column | Status |
| --- | --- | --- |
| Per month, or per loan? | `interest_basis` | **open** |
| Flat, or reducing balance? | `interest_method` | **open** |
| What multiple of savings? | `savings_to_loan_multiplier_bps` | **open** |
| What does a monthly collection do in a short month? | `repayment_frequencies.month_anchor` | **open** |

`member_loan_interest()` implements three of the four combinations and
**refuses** the fourth:

| Basis | Method | Behaviour |
| --- | --- | --- |
| `per_month` | `reducing_balance_monthly` | delegates to `calculate_loan_breakdown` |
| `per_month` | `flat` | `principal × rate × months` |
| `per_loan` | `flat` | `principal × rate`, once |
| `per_loan` | `reducing_balance_monthly` | **raises**: undefined |

The fourth is not an omission. "5% of the whole loan, on a reducing balance"
does not describe a calculation: a reducing-balance schedule charges a rate
*per period* on the balance outstanding in that period, and a rate that is not
per-period has nothing to reduce against. Implementing something would have
meant inventing a financial rule, which is the one thing this phase must not
do. `tests/unit/member-loan.test.ts` asserts the refusal.

The per-month reducing-balance arm **delegates** rather than reimplementing.
There is one reducing-balance engine in this system and `calculate_loan_breakdown`
is it; a second would be a second answer to the same question, and the two
would diverge on a rounding boundary nobody tested.

None of the four is defaulted anywhere. The interface names each one that is
open, where it lives, and what it costs to leave it open —
`MEMBER_LENDING_DECISIONS` and `MemberLendingStatus`. `memberLendingReadiness`
reports `pricingReady` separately from `isReady`, so a programme that has
answered the three policy questions and not the anchor is described
accurately: weekly member loans of one and two months work, and three- to
five-month loans are refused.

---

## 8. Row Level Security

Both new tables: RLS enabled, every grant revoked, SELECT re-granted to
`authenticated` behind a capability, no INSERT/UPDATE/DELETE grant to anybody.
Rows are written only by `approve_loan`, which is `SECURITY DEFINER`.

```
  member_loan_eligibility_snapshots   select  loans:view
  member_loan_savings_pledges         select  loans:view
  member_loan_eligibility  (view)     security_invoker = true
  member_loan_register     (view)     security_invoker = true
```

`member_loan_eligibility_of` is `SECURITY DEFINER` and **unreachable from a
session**: `revoke all … from public, anon, authenticated`, so no request
arriving at PostgREST can call it. It reads savings histories across members,
which no session may do directly. The way in is
`assess_member_loan_eligibility`, which checks
`member_loans:view_eligibility` first and restates the branch rule.

`service_role` keeps execute, as on every such function here — it is the
backend key, it bypasses RLS by design, and it can read those rows directly
anyway. The same arrangement `generate_loan_schedule` has had since Phase 5.

`member_loan_summary()` asks for `loans:view` and reports the business, so it
is `SECURITY DEFINER` by ADR-057. It reports no total ceiling: summing what
the business *could* lend across every member would be read as a commitment
nobody made.

---

## 9. Capabilities

Two, and deliberately not three:

| Capability | Held by | Why |
| --- | --- | --- |
| `member_loans:view_eligibility` | Secretary/Treasurer, Manager, Owner | answering "do I qualify yet?" is counter work |
| `member_loans:create` | Manager, Owner | opening an application commits the business to lend against member savings |

There is **no** `member_loans:approve`. Approval is `loans:approve`, because a
member loan is a loan and a separate approval capability would mean a person
who could approve member loans and not ordinary ones — a distinction the
business does not make and a second path to audit.

`lib/auth/routing.ts` lists `/member-loans/new` **before** `/member-loans`, so
the application page does not inherit the section's floor. The browser suite
points a Secretary straight at the URL.

---

## 10. Screens

| Screen | Path | What it is for |
| --- | --- | --- |
| Who can borrow | `/member-loans` | every live membership, its qualifying months, what its savings support |
| Member loans | `/member-loans?tab=loans` | member loans, with the membership and the pledge beside each |
| New application | `/member-loans/new?client=…` | the application, with a live repayment preview |
| Eligibility panel | `/membership/{id}` | the assessment, on the member's own record |
| Member loan panel | `/loans/{id}` | the frozen assessment, the agreed price, the pledge |

Two registers rather than one list, because "who can borrow" and "who has
borrowed" are asked by the same person at different moments and answered from
different tables. A member with no loan has no row in the loan register, and a
cleared loan has no bearing on eligibility.

The repayment preview is the **contract** — a month-by-month statement of what
falls due — and not the collection plan. Collection dates are generated at
disbursement from the day the money actually reaches the member, so quoting a
date on the form would be quoting a day nobody has fixed.

---

## 11. Tests

| Suite | File | Count |
| --- | --- | --- |
| Eligibility | `tests/db/member-loan-eligibility.test.ts` | 26 |
| Approval and the snapshot | `tests/db/member-loan-approval.test.ts` | 27 |
| The calendar cadence | `tests/db/calendar-month-schedule.test.ts` | 34 |
| RLS, grants, definers | `tests/db/member-loan-security.test.ts` | 25 |
| Concurrency | `tests/db/member-loan-concurrency.test.ts` | 7 |
| The domain module | `tests/unit/member-loan.test.ts` | 50 |
| The demonstration seeder | `tests/db/member-loan-demo-seed.test.ts` | 24 |
| The browser, read-only | `tests/e2e/specs/member-loans.spec.ts` | 31 |
| The browser, writing | `tests/e2e/specs/member-loans.write.spec.ts` | 5 |

The browser figures are test *cases*. The read-only file runs in both the
desktop and the mobile project, so it contributes 62 executions; the write
file runs on desktop only, because an approval takes a pledge and makes that
member hold a live loan — running it twice would meet `active_loan_exists` on
the second pass and fail for the first pass's success.

The demonstration seeder's suite is its own vitest project
(`seed-member-loans`) for two reasons, either of which would be enough: it
publishes policy version 998.0 as the only version in force, and it reuses
existing borrowers, which needs a database the synthetic seeder has never
touched.

It builds a real loan book first — two borrowers disbursed and repaid in full,
plus six more — snapshots every figure loan by loan, runs the seeder, and
compares. A seeder that nudged one installment date while adding a member loan
would be a seeder that changed what a borrower owes.

---

## 12. A Phase 2 behaviour worth knowing about

`savings_accounts.policy_version_id` is frozen at opening, and
`member_savings_qualification` judges an account against that version.
Publishing a second policy version supersedes the first — and a superseded
version authorises nothing, so **every account opened under it stops
qualifying**. A recorded re-acceptance moves the *membership* to the new
version; it cannot move the account.

This is Phase 2 behaviour, and Phase 3 does not change it: a change here would
move the qualification of accounts already open, which is exactly the kind of
retroactive movement the frozen version exists to prevent. What Phase 3 does
is stop tripping over it. `scripts/demo-member-loans.ts` publishes its TEST
ONLY version as the demonstration's **only** version and refuses outright on a
database where another is in force, saying why.

Whoever answers the three open questions will publish a new version, and the
members enrolled under the old one will need their accounts handled
deliberately. That is a migration, not a side effect, and it is the right
place to decide it.

---

## 13. Deploying this

Nothing in Phase 3 has been deployed, and the order below is the order it has
to happen in. Each step is reversible until the one after it.

### The migrations

Ten files, `20261021000100`–`20261021001000`, applied in filename order. They
reference tables Phase 2 creates, so Phases 1 and 2 must already be applied.

None of them is destructive. No column is dropped, no constraint relaxed, no
policy widened, and no row of financial history touched. Three functions are
replaced — `generate_loan_schedule`, `validate_loan_for_approval` and
`approve_loan` — by `create or replace`, so a rollback is the previous
definition reapplied rather than a data migration.

Before applying them to any database that carries a real book, run
`node scripts/verify-membership-upgrade.mjs` against a copy of it. It applies
every Polytos migration to a populated database and compares 28 financial
figures, including every collection date loan by loan. Phase 3 is the first
phase that could move one.

### What ships closed

| Object | Ships | Opened by |
| --- | --- | --- |
| `loan_products` `ML` | `inactive` | the Owner, on the Loan Products screen |
| `repayment_frequencies` `monthly` | `is_active = false`, `month_anchor` NULL | setting the anchor, then activating |
| `repayment_frequencies` `weekly` | **active** | — |

Nothing has to be done to the weekly cadence. It is an ordinary fixed-day
cadence of seven days and it works today.

### The order to open member lending in

1. **Answer the three policy questions** and publish a new policy version
   carrying the answers: `interest_basis`, `interest_method`,
   `savings_to_loan_multiplier_bps`. A version is immutable once approved, so
   this is a new version rather than an edit.

   **Read §12 before doing this.** Publishing supersedes the version in force,
   and every savings account opened under the old one stops qualifying until
   it is handled deliberately. That is a migration to plan, not a side effect
   to discover.

2. **Decide the monthly collection anchor** and set
   `repayment_frequencies.month_anchor` for `monthly`. Write-once: settable
   while NULL, frozen from that moment, because schedules will be generated
   from it. Then set `is_active = true`.

   Skipping this step is a legitimate choice. Weekly member loans of one and
   two months work without it; three- to five-month loans stay refused.

3. **Activate the `ML` product** and set `allowed_repayment_frequencies` to
   the cadences the business will actually collect on.

After each step the database's own answer changes, and
`member_lending_blocked_reason()` says what is still missing. There is no
flag to flip and no deployment to repeat: all three are configuration.

### What to watch after opening it

- `member_loan_summary()`'s **Secured against savings** figure against
  `sum(pledged_amount) where released_at is null`. They are the same query;
  a difference means something wrote a pledge outside `approve_loan`.
- The savings subledger against ledger account `2100` — unchanged by member
  lending, and the first thing a pledge that moved money would break.
- `member_loan_eligibility_snapshots` growing one row per approved member
  loan, and no more.

---

## 14. What Phase 4 will need from this

Phase 4 is membership benefits and meetings. Three things here are built for
it rather than for this phase, and one is a decision it will have to make.

**The frozen snapshot pattern.** `member_loan_eligibility_snapshots` is what a
benefit claim's own assessment should look like: append-only, keyed on the
thing it justifies, with the rules restated as CHECK constraints so a row
cannot contradict the policy it claims to follow. A claim assessed against a
medical benefit cap needs exactly that, for exactly the same reason — somebody
will ask, a year later, what the business saw when it decided.

**`membership_policy_allows(version, activity)`.** Phase 1 built five activity
gates and Phase 3 uses the third. Benefits is the fourth, and it needs no new
mechanism: `is_benefits_enabled` is already a generated column waiting on
questions 7, 8 and 9.

**The per-member assessment function shape.** `member_loan_eligibility_of` is
`SECURITY DEFINER`, unreachable from a session, and wrapped by a function that
checks a capability and restates the branch rule. A benefit eligibility
function has the same problem — it must read across members to answer about
one — and should have the same shape rather than a new one.

**The decision Phase 4 has to make.** A member with a live member loan has
part of their savings pledged. If a bereavement benefit is payable to their
next of kin while a member loan is outstanding, somebody has to say whether
the benefit is reduced by what the loan owes, whether the pledge is released
first, or whether the two are independent. Phase 3 deliberately does not
answer it: `member_loan_release_pledge()` releases on the loan leaving live
status and nothing else, and offsetting a benefit against a loan would be
inventing a financial rule. It is a question for the client, and it belongs
on the list in `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` when Phase 4
starts.

---

## 15. What this phase does not do

- **It does not activate member lending.** The `ML` product ships `inactive`
  and the `monthly` cadence ships `inactive`. Four decisions are open, and the
  database refuses an approval that depends on any of them.
- **It does not default a single open decision.** Not the basis, not the
  method, not the multiplier, not the anchor. Every screen that would show one
  shows "Not yet decided" instead.
- **It does not change an existing loan.** No figure, no date, no balance, no
  journal entry. `scripts/verify-membership-upgrade.mjs` proves it on a
  populated book.
- **It does not touch non-member lending.** A client may borrow without being
  a member, and the browser suite asserts that an ordinary loan shows no
  membership panel and the loan register still lists the whole book.
- **It does not disburse member loans automatically, net anything against
  savings, or offset a pledge against a loan balance.** A pledge restricts;
  it does not pay.
- **It does not implement benefits or profit sharing.** Phases 4 and 5.
