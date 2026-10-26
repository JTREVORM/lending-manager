# Polytos Phase 3 — test report

Every figure in this document was produced by running the command named beside
it. Where something did not run, this report says so and says why, rather than
reporting it as passed.

Environment: Node 22.22.0, PostgreSQL 16, Chromium from
`PLAYWRIGHT_BROWSERS_PATH`, PostgREST 12.2.3, all local.

**No hosted Supabase project was contacted at any point.** No migration was
applied to a hosted database, no hosted demonstration record was created,
changed or deleted, and the connection named `Primary` was never opened — its
project reference is deliberately recorded nowhere in this repository, and the
demonstration seeder's allow-list refuses every project but one. The member
loan demonstration refuses a hosted target outright, whatever the allow-list
says, because it publishes a policy version answering three decisions the
client has not made.

**Nothing was deployed.** No Vercel deployment was triggered, no hosted
migration applied, and no pull request opened.

---

## 1. Summary

| Test category | Command | Result |
| --- | --- | --- |
| TypeScript typecheck | `npm run typecheck` | **Passed**, 0 errors |
| ESLint | `npm run lint` | **Passed**, 0 errors, 0 warnings |
| Prettier | `npm run format:check` | **Passed**, all files conform |
| Production build | `npm run build` | **Passed**, 2 new routes emitted |
| Unit + integration | `npm run test:run` | **Passed** — 74 files, 2,441 tests |
| Database suite | `vitest run --project db` | **Passed** — 66 files, 1,620 tests |
| Demonstration seeder | `vitest run --project seed` | **Passed** — 18 tests |
| Borrower reuse | `vitest run --project seed-reuse` | **Passed** — 15 tests |
| Member loan demonstration | `vitest run --project seed-member-loans` | **Passed** — 24 tests |
| Upgrade path + financial regression | `node scripts/verify-membership-upgrade.mjs` | **Passed** — 28 figures identical |
| Financial arithmetic audit | `npm run audit:money` | **Passed** — 71 files, 5 engines, no hazard |
| Browser tests | `npx playwright test` | **Passed** — 698 passed, 32 skipped, 0 failed |

### Totals, with and without this phase

Stated both ways so nothing is hidden behind a bigger number.

| Suite | Before Phase 3 | After | Added |
| --- | --- | --- | --- |
| Unit + integration | 73 files, 2,389 tests | 74 files, 2,441 tests | 52 |
| Database | 61 files, 1,497 tests | 66 files, 1,620 tests | 123 |
| Demonstration seeder | 1 file, 18 tests | 1 file, 18 tests | 0 |
| Borrower reuse | 1 file, 15 tests | 1 file, 15 tests | 0 |
| Member loan demonstration | — | 1 file, 24 tests | 24 |
| Browser (executions, both projects) | 20 files, 659 | 22 files, 730 | 71 |

The browser row counts **executions**, not files' test cases: a spec that runs
in the desktop and the mobile project contributes twice. Phase 3's 71 are 31
cases in `member-loans.spec.ts` run in both projects, 5 in
`member-loans.write.spec.ts` on desktop only, and 2 accessibility paths added
to a sweep that runs in both.

**No existing test was deleted, skipped or weakened**, and one existing
assertion was rewritten because Phase 3 made it ambiguous rather than wrong —
recorded in §9 with the before and after.

---

## 2. The three defects these tests found

All three were in the eligibility ceiling, all three were in code that read
correctly and typechecked, and all three would have passed any test written
from the implementer's side. Each needed a test that asked *what does this
member actually get if they come back tomorrow?*

### 2.1 The ceiling ignored capacity a live pledge had already consumed

The first draft computed `max_eligible_loan` from the savings balance
`member_savings_qualification` reported — which is the whole balance,
including the part already securing a loan the member is still repaying.

**A member with UGX 300,000 saved and a UGX 200,000 member loan running could
borrow against the full 300,000 again.** At a 1× multiplier they would end up
with 400,000 lent against 300,000 saved, and the second loan's pledge would
exceed what the account held.

- **Found by:** `tests/db/member-loan-eligibility.test.ts` → *"reduces the
  ceiling by what a live pledge already secures"*.
- **Fixed by:** subtracting `savings_pledged_amount` inside
  `member_loan_eligibility_of`, and asserting in `approve_loan` that live
  pledges never exceed the account balance — a belt as well as braces, because
  the assertion catches any future path that computes the ceiling wrongly.
- **Now asserted:** the ceiling falls by exactly the pledge, and the
  post-approval assertion is exercised directly.

### 2.2 A withdrawal on its way out was not reserved

A withdrawal request sits `pending` until somebody decides it. The money is
still in the account and still in the balance, and the first draft counted it
as available to secure a loan.

**A member could request a withdrawal of their whole balance and, before it
was decided, take a loan secured against the same money.** Both would then be
honoured: the withdrawal because it was approved before the loan's pledge
existed, the loan because the ceiling said it was covered.

- **Found by:** `tests/db/member-loan-eligibility.test.ts` → *"reserves a
  withdrawal that is requested and not yet decided"*.
- **Fixed by:** `pending_withdrawals` is a column of the assessment and is
  subtracted from `available_savings`, restated as the
  `member_loan_snapshots_available_follows` CHECK constraint so a snapshot
  cannot claim otherwise.
- **Now asserted:** both orders — withdrawal then loan, loan then withdrawal —
  and the race between them in
  `tests/db/member-loan-concurrency.test.ts`.

### 2.3 The ceiling rounded half-up while the pledge rounds up

`memberLoanCeiling` used the repository's standard `applyRateBps` helper,
which rounds half-up. The pledge divides the other way and rounds **up**,
because a pledge must never be a shilling short of what the multiplier says
secures the loan.

Below a 1× multiplier the two disagree. At 5,000 bp (0.5×) and 300,000 saved,
a half-up ceiling permits 150,000; the pledge for 150,000 is
`ceil(150,000 × 10,000 / 5,000)` = 300,000 — exactly the balance — and one
shilling more of principal would pledge more than the member has.

- **Found by:** `tests/unit/member-loan.test.ts` → *"never pledges more than
  the member holds, at any savings and any multiplier"*, which sweeps seven
  savings balances against seven multipliers rather than checking one pair.
- **Fixed by:** `memberLoanCeiling` now uses `applyRateBps(..., 'down')`, and
  the SQL ceiling uses integer division, which floors. The two now point the
  same way: never lend a shilling more than the multiplier supports, never
  secure a shilling less.
- **Now asserted:** the invariant *the pledge for the ceiling never exceeds
  the available savings* is checked across that sweep, and
  `approve_loan` asserts the same thing inside its own transaction.

### A fourth finding, documented rather than changed

`savings_accounts.policy_version_id` is frozen at opening and
`member_savings_qualification` judges an account against that version.
Publishing a second policy version supersedes the first, and a superseded
version authorises nothing — so **every account opened under it stops
qualifying**. A recorded re-acceptance moves the membership to the new
version; it cannot move the account.

This is Phase 2 behaviour. Phase 3 did not change it, because a change here
would move the qualification of accounts already open — exactly the
retroactive movement the frozen version exists to prevent. What Phase 3 does
is stop tripping over it: `scripts/demo-member-loans.ts` publishes its TEST
ONLY version as the demonstration's only version and refuses on a database
where another is in force, naming the reason.

Recorded in `docs/POLYTOS-MEMBER-LOANS.md` §12 so whoever publishes the real
version plans for it.

---

## 3. Database suite

```
vitest run --project db
  Test Files  66 passed (66)
       Tests  1620 passed (1620)
```

The five new files, and what each is for:

| File | Tests | What it establishes |
| --- | --- | --- |
| `member-loan-eligibility.test.ts` | 26 | The assessment: qualification, the ceiling, what reduces it, and that an undecided policy yields no ceiling at all |
| `member-loan-approval.test.ts` | 27 | Every refusal code, the frozen snapshot, the pledge, and that the terms come from the borrower's own policy version |
| `calendar-month-schedule.test.ts` | 34 | Both anchor conventions across every 31-day month boundary of a year, and that an undecided anchor raises |
| `member-loan-security.test.ts` | 25 | RLS, grants, the definer inventory, and that `member_loan_eligibility_of` is unreachable without the wrapper |
| `member-loan-concurrency.test.ts` | 7 | Two approvals against one balance; a withdrawal against an approval; both with real concurrent transactions |

Three assertions were added to `tests/db/schedule-parity.test.ts` and one test
to `tests/db/loan-products.test.ts` (the two term ceilings, ADR-060).

### The concurrency tests are real concurrency

Each opens two connections, runs both to the point of decision, and then
releases them. They are not two sequential transactions with a comment
claiming otherwise:

- **two approvals, one balance.** Two member loans, each individually within
  the ceiling, approved simultaneously against one savings account. Exactly
  one succeeds; the other is refused `member_amount_above_ceiling`, because
  `approve_loan` takes `lock_savings_capacity` *before* it validates.
- **a withdrawal against an approval.** A withdrawal request and a loan
  approval, both against the same savings. Whichever commits first bounds the
  other, and the member's savings never secure a loan and leave the account.

The file also asserts what the capacity lock is *not*: the one-active-loan
limit is a separate control with its own advisory lock on the client, and
`tests/db/member-loan-concurrency.test.ts` → *"keeps the one-active-loan limit
as a separate control"* holds the two apart, so neither is mistaken for the
other's guarantee. Two further races are covered: a member loan disbursed
twice at once writes one schedule, and whatever the ordering there is exactly
one eligibility snapshot and one pledge per loan.

There is **no** negative control proving these tests fail without the lock.
Writing one would mean shipping a second, lockless copy of `approve_loan` for
the test to exercise, which is a worse thing to have in the schema than the
assurance is worth. The locks are visible in the function bodies and the
primary keys on both new tables make a duplicate impossible regardless.

---

## 4. The member loan demonstration seeder

```
vitest run --project seed-member-loans
  Test Files  1 passed (1)
       Tests  24 passed (24)
```

Its own vitest project, for two reasons either of which would be enough: it
publishes policy version 998.0 as the **only** version in force, and it
reuses existing borrowers, which needs a database the synthetic seeder has
never touched.

### What the suite actually does

1. Builds a real loan book: two borrowers disbursed and repaid in full, so
   there are genuine schedules, payments, allocations and journal entries on
   both sides of the ledger, plus six more so reuse has people to map onto.
2. Snapshots every figure of those eight loans **loan by loan** — not summed,
   because a total can stay still while two contracts swap figures.
3. Runs the seeder with borrower reuse and member loans both enabled.
4. Compares. Every pre-existing loan identical, every collection date where it
   was, and no existing loan re-pointed at the member product.
5. Runs it twice more and asserts a fixed point.

### The six scenarios, and that four of them are refusals

| Scenario | What it demonstrates | Outcome |
| --- | --- | --- |
| A | a qualified member with a running member loan, collected once | active |
| B | an application awaiting a decision | draft |
| B2 | refused for asking above what their savings support | `member_amount_above_ceiling` |
| C | refused for want of qualifying months | `member_not_qualified` |
| E | refused on two counts at once | `member_amount_above_ceiling`, `member_not_qualified` |
| D | a suspended member | `member_not_active`, `member_not_qualified` |

The refusals are the demonstration. An interface can be made to *show* a
refusal; only a refusal the database actually issued proves the control is
there. Scenario E exists because `validate_loan_for_approval` returns a **set**
of codes rather than the first — an approver is told everything that has to
change.

Scenario B2 was added after the first run: E was intended as the ceiling-only
case and legitimately refused for two reasons, so it was relabelled truthfully
and a member who qualifies on every other count was used for the single-reason
refusal.

### What it reconciles, every run

- the savings subledger equals ledger account `2100`;
- no savings account secures more than it holds;
- every member loan's schedule collects its contractual total;
- the trial balance foots.

### Idempotency

Three consecutive runs on a fresh local database:

```
loans=6 payments=1 journals=34 pledges=1 snapshots=1 savings=1010000 installments=8
run 2: identical
run 3: identical
```

Twice could pass on a guard that happens to catch the state the first run
leaves; three times means the state is a fixed point.

---

## 5. Upgrade path and financial regression

```
node scripts/verify-membership-upgrade.mjs

  applying 95 existing migrations
  seeded 14 loans, 165 payments, 178 journal entries
  applying 32 Polytos migrations on top
  … 28 figures compared …
  Upgrade verified: every one of 28 financial figures is identical
```

This is the mandatory financial regression certification: a database carrying
the **released** schema and a representative book, upgraded in place by the
Polytos migrations alone, with a full baseline taken before and after.

Phase 3 is the phase this check matters most for. It is the only phase that
rewrites a function computing collection dates — `generate_loan_schedule`
gains a second cadence arm — so it is the only one whose migrations could move
a date on a loan already written. The `installment_schedule` figure compares
**every collection date and every scheduled amount, loan by loan, in order**.

Two figures needed attention:

- `account_balances` and `trial_balance` tolerate new accounts provided they
  are at zero. Phase 2 established that; Phase 3 added none.
- `audit_count` became **`audit_trail`**. Phase 3 seeds a loan product, so it
  writes the first audit row any migration has ever written —
  `product.created`, by the trigger that has always watched that table — and a
  count cannot tell that row apart from a migration inventing a payment. The
  trail is now compared **row by row**: every existing row must still be there
  unchanged, and an added row is allowed only when it is about configuration
  the migration created itself. That is a stronger assertion than the count it
  replaces, not a weaker one.

The script then runs the borrower-reuse integration against the same populated
book and asserts the loan book is untouched by that too.

---

## 6. Financial arithmetic audit

```
npm run audit:money
  71 financial files scanned, no hazard found
  all five engines reach only integer/BigInt money helpers
  2 acknowledged non-money exemption(s), each verified present
  scanner verified against a positive control
```

Phase 3 extended the audit rather than being exempted from it:
`lib/domain/member-loan.ts` was added to the scanned set, a fifth engine was
registered, and the `20261021` migrations were added to the SQL sweep. The
file count went 60 → 71 and the engine count 4 → 5.

One exemption needed renaming. The audit is keyed on text, and renaming a
variable `intervalDays` → `step_days` invalidated a stale exemption key — the
scanner reported the exemption as absent, which is the scanner working: an
exemption whose subject has moved is not an exemption. Renamed to
`cadenceIntervalDays` and the key updated.

---

## 7. Browser tests

```
npx playwright test
```

Two new spec files, run against the **production build** on a freshly seeded
isolated stack — real PostgreSQL with every migration applied, the real
PostgREST binary, and `next start`, not the dev server.

```
npx playwright test
  32 skipped
  698 passed (18.0m)
```

| File | Cases | Project | What it establishes |
| --- | --- | --- | --- |
| `member-loans.spec.ts` | 31 | desktop + mobile | Every screen renders; the figures agree with the database; the capability is the control; 390px does not scroll sideways |
| `member-loans.write.spec.ts` | 5 | desktop only | An application opened through the form; an approval that pledges, freezes and schedules; the pledge moved no money |

The write file is desktop-only because an approval takes a pledge and makes
that member hold a live loan: running it twice would meet `active_loan_exists`
on the second pass and fail for the first pass's success.
`playwright.config.ts` excludes `*.write.spec.ts` from the mobile project for
exactly this reason.

The 32 skips are that exclusion plus the five `on a phone` cases that skip in
the desktop project. No test is skipped because it fails.

### What the harness decides, and what it leaves open

The harness answers the three member-lending **policy** questions with
illustrative figures and leaves the fourth — the monthly collection anchor —
open. The figures are named as the harness's own in the policy version's notes,
like every other figure it seeds.

That is the most informative single state the system has, and it was chosen
rather than settled for:

- weekly member loans of one and two months can be priced, approved,
  scheduled and collected, so every Phase 3 screen has real data on it;
- a three-month loan is **refused**, because it needs the calendar-monthly
  cadence and the cadence needs the anchor — which is the consequence of
  answering three of four, and the one nobody would guess;
- the status banner still names an outstanding decision, so the screen that
  exists to say what is missing has something to say.

The fully blocked state — nothing priceable at all — is covered by the
database suite's refusals and by the demonstration seeder's four.

### A defect the browser found, which no unit test could

`MemberLendingStatus` led with:

> Applications can be prepared and eligibility can be read. **Nothing can be
> approved**: the database refuses it…

That is true when a policy question is open. It is **false** in the state the
harness is in, where weekly member loans are approved and running. A banner
that says nothing can be approved while loans are being approved every day is
a banner people stop reading — which is the exact lesson Phase 1 recorded from
the other direction.

Fixed by splitting `pricingReady` from `isReady` in `memberLendingReadiness`:
the three policy questions decide whether a loan can be **priced**, and the
anchor decides whether a longer one can be **scheduled**. The banner now says
which. Asserted in `tests/unit/member-loan.test.ts` and in the browser.

This was only visible because the harness was put into a partially-open state
and the page was actually opened. No unit test would have found it: the string
was correct in the state the unit tests exercised.

### A second finding, from a test that had never rendered its subject

`RiskBreakdown` returns `null` for a single slice, because a one-row breakdown
says nothing the summary above it did not. Every harness loan was on one
product until Phase 3 put a member loan in the book — so the
**by-loan-product PAR table had never rendered in a browser**, and the
existing `security-recovery.write.spec.ts` assertion for `PAR 1` became
ambiguous the moment it did.

Scoped the existing assertion to the summary's own definition list, and added
a test for the breakdown table, which is coverage the Phase 3 data unlocked
rather than a workaround for it.

---

## 8. What the tests establish about the security model

| Claim | Asserted by |
| --- | --- |
| `member_loan_eligibility_of` is unreachable without the capability wrapper | `member-loan-security.test.ts` — called directly as `anon`, `authenticated` and `service_role` |
| Neither new table accepts a write from any session | `member-loan-security.test.ts` — INSERT, UPDATE and DELETE attempted as each role |
| Both tables are append-only even for the table owner | statement-level guard triggers, asserted as the owner |
| A snapshot cannot contradict its own figures | `snapshots_within_ceiling` and `snapshots_qualified`, each violated deliberately as the table owner |
| A pledge cannot be written for the wrong amount | `member_loan_pledges_amount_follows`, violated deliberately |
| Approval terms come from the borrower's version, not the caller | `member-loan-approval.test.ts` — a loan drafted with a rate is repriced at approval |
| The membership and basis are frozen at approval | `loans_guard_member_terms`, attempted as the owner and as `service_role` |
| A Secretary may read eligibility and not open an application | `member-loans.spec.ts`, pointed straight at the URL |
| A borrower reaches none of the staff screens | `member-loans.spec.ts` |
| The audit trail carries no name, phone or savings balance | `member-loan-demo-seed.test.ts` — the JSON keys are checked, not a text scan |

---

## 9. The one existing assertion Phase 3 rewrote

`tests/e2e/specs/security-recovery.write.spec.ts` →
*"states PAR with the principal behind it, at all five thresholds"*

**Before:** `page.getByText('PAR 1', { exact: true })`

**After:** scoped to `page.getByRole('term')`, with a new sibling test for the
by-product breakdown table.

**Why:** not because the assertion was wrong, but because Phase 3 made it
ambiguous. The page now legitimately contains the label twice — once in the
summary and once as a column header in a table that only renders when the
book carries more than one loan product. The assertion's subject did not
change; the page gained a second element with the same text.

The schedule-audit test also moved, and for the opposite reason: an earlier
draft bumped `generator_version` to 2 for every schedule, and the test caught
it. The **test** was right and the implementation was wrong — fixed-day rules
did not change, so fixed-day schedules stay at version 1.

---

## 10. Deviations, and what is not covered

- **Hosted Supabase was never contacted.** The specification permits
  development against an isolated local PostgreSQL where hosted access is not
  configured, and reports that. Hosted access is not configured in this
  environment: no connection named `LENDING MANAGER` was available, and the
  connection named `Primary` was deliberately never opened. Every figure in
  this report comes from a local throwaway cluster.
- **Nothing was deployed.** No Vercel deployment, no hosted migration, no pull
  request.
- **The `per_loan` + `reducing_balance` combination is not implemented.** It
  does not describe a calculation; the function raises and the refusal is
  asserted. See `docs/POLYTOS-MEMBER-LOANS.md` §7.
- **No performance certification against a larger book.** Phase 6's job, and
  the new indexes are in place for it. What *was* measured is each new screen's
  median load and horizontal overflow at four viewports, by
  `scripts/capture-member-loan-screens.mjs`: the slowest is the member loan
  detail screen at 328 ms on desktop and 241 ms on a phone, and every screen
  at every viewport overflows by 0 px.
- **Member lending is not activated.** The `ML` product and the `monthly`
  cadence both ship `inactive`, and four decisions are open. That is the state
  the specification requires, not an omission.

---

## 11. Verification commands, in order

```bash
npm run typecheck
npm run lint
npm run format:check
npm run audit:money
npm run test:run
npm run build

# Needs a local PostgreSQL. Rebuilds the database per project.
./scripts/pg-local.sh setup
DATABASE_URL=postgresql://lending@localhost:5433/lending_test npm run test:db
node scripts/verify-membership-upgrade.mjs

# Needs the end-to-end stack: PostgreSQL, PostgREST, the auth shim,
# a fresh seed and the production build.
tests/e2e/harness/stack.sh up
source <(tests/e2e/harness/stack.sh env)
npx playwright test
node scripts/capture-member-loan-screens.mjs
tests/e2e/harness/stack.sh down
```
